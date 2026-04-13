"""
Clip extractor — cuts event-timed segments from a video and concatenates
them into a single highlight reel using FFmpeg.

FFmpeg must be installed and on PATH:
  Windows : winget install ffmpeg
  macOS   : brew install ffmpeg
  Linux   : apt-get install ffmpeg
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from typing import Callable

log = logging.getLogger(__name__)


@dataclass
class ClipSegment:
    start: float
    end: float
    label: str = ""


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def require_ffmpeg() -> None:
    if not ffmpeg_available():
        raise RuntimeError(
            "ffmpeg not found on PATH.\n"
            "  Windows : winget install ffmpeg\n"
            "  macOS   : brew install ffmpeg\n"
            "  Linux   : apt-get install ffmpeg\n"
            "Then restart the Flask server."
        )


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            + result.stderr.decode(errors="replace")
        )


def _cut_clip(video_path: str, start: float, duration: float, output_path: str) -> None:
    # Output-side -ss (after -i) is the only reliable frame-accurate approach.
    # FFmpeg internally does a container seek + frame-level discard, so it
    # doesn't need to decode the entire file from the beginning, and the cut
    # is exact regardless of keyframe positions or B-frame reordering.
    # Input-side -ss seeks to the nearest keyframe (fast, no full decode).
    # -c copy avoids re-encoding so even 1080p clips finish in seconds.
    # The clip may start up to ~2s early (keyframe alignment) which is
    # covered by the padding_before buffer.
    _run([
        "ffmpeg", "-y",
        "-ss", f"{max(start, 0):.3f}",
        "-i", video_path,
        "-t",  f"{max(duration, 0.5):.3f}",
        "-c", "copy",
        "-movflags", "+faststart",
        output_path,
    ])


def _concat_clips(clip_paths: list[str], output_path: str) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, encoding="utf-8"
    ) as flist:
        for p in clip_paths:
            flist.write(f"file '{p.replace(chr(92), '/')}'\n")
        flist_path = flist.name
    try:
        _run([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", flist_path,
            "-c", "copy",
            "-movflags", "+faststart",
            output_path,
        ])
    finally:
        os.unlink(flist_path)


def generate_highlight_reel(
    video_path: str,
    segments: list[ClipSegment],
    output_dir: str,
    on_progress: Callable[[int, int], None] | None = None,
) -> str:
    """
    Cut each segment and concatenate into one MP4.
    Returns the absolute path of the output file.
    """
    require_ffmpeg()

    if not segments:
        raise ValueError("No segments provided.")
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    output_path = os.path.join(output_dir, f"highlights_{uuid.uuid4().hex[:10]}.mp4")

    with tempfile.TemporaryDirectory() as tmpdir:
        clip_paths: list[str] = []

        for i, seg in enumerate(segments):
            clip_path = os.path.join(tmpdir, f"clip_{i:04d}.mp4")
            log.info("Cutting %d/%d — %s", i + 1, len(segments), seg.label)
            try:
                _cut_clip(video_path, seg.start, seg.end - seg.start, clip_path)
                clip_paths.append(clip_path)
            except Exception as exc:
                log.warning("Skipping clip %d: %s", i, exc)
            if on_progress:
                on_progress(i + 1, len(segments))

        if not clip_paths:
            raise RuntimeError("All clip cuts failed — check video file and timestamps.")

        if len(clip_paths) == 1:
            shutil.move(clip_paths[0], output_path)
        else:
            _concat_clips(clip_paths, output_path)

    return output_path


def _to_video_time(
    match_s: float,
    clock_map: list[dict] | None,
    half_offsets: dict | None,
    period: int = 1,
) -> float | None:
    """Convert match seconds to video seconds using clock map or per-half offset."""
    from services.clock_scanner import interpolate_video_time

    if clock_map:
        vt = interpolate_video_time(match_s, clock_map)
        if vt is not None:
            return vt
        s = sorted(clock_map, key=lambda x: x["match_seconds"])
        last = s[-1]
        delta_match = match_s - last["match_seconds"]
        if 0 < delta_match <= 600:
            return last["video_seconds"] + delta_match
        return None

    if half_offsets:
        offset = (half_offsets.get(period)
                  or half_offsets.get(1)
                  or half_offsets.get(2))
        if offset is not None:
            return match_s + offset
    return None



def events_to_segments(
    events: list[dict],
    half_offsets: dict | None = None,
    padding_before: float = 5.0,
    padding_after: float = 10.0,
    video_duration: float | None = None,
    clock_map: list[dict] | None = None,
    all_events: list[dict] | None = None,
) -> list[ClipSegment]:
    """
    Convert StatsBomb events → ClipSegments.

    If *all_events* is supplied the clip end time is determined by scanning
    forward through the full event stream: the clip continues while the same
    player has the ball (Carry, Pass, Shot, …) and stops when possession
    switches to another player or after *padding_after* seconds, whichever
    is sooner.
    """
    # Build a sorted lookup of all events by match_seconds for smart ending
    sorted_all = sorted(all_events or [], key=lambda e: e.get("match_seconds") or 0)

    segments: list[ClipSegment] = []
    for e in events:
        match_s = e.get("match_seconds") or 0
        period  = e.get("period") or 1
        player  = e.get("player")

        video_time = _to_video_time(match_s, clock_map, half_offsets, period)
        if video_time is None:
            continue
        if video_time < 0:
            continue
        if video_duration is not None and video_time > video_duration:
            continue

        start = max(0.0, video_time - padding_before)

        # Smart end: scan forward and stop 1s after the first event by a different player.
        # Falls back to padding_after only if no possession change is found.
        possession_end_match_s = None
        if player and sorted_all:
            for future in sorted_all:
                fms = future.get("match_seconds") or 0
                if fms <= match_s:
                    continue
                if fms > match_s + 60:
                    break  # safety cap
                if future.get("player") != player:
                    possession_end_match_s = fms + 1
                    break

        # Always guarantee at least padding_after seconds from the event.
        # Possession change only extends beyond that — never cuts it short.
        min_end = video_time + padding_after
        if possession_end_match_s is not None:
            end_vt = _to_video_time(possession_end_match_s, clock_map, half_offsets, period)
            end = max(min_end, end_vt if end_vt is not None else min_end)
        else:
            end = min_end

        if video_duration is not None:
            end = min(end, video_duration)

        if end <= start:
            continue

        label = (
            f"{e.get('player', '?')} – "
            f"{e.get('type', '?')} "
            f"{e.get('minute', '?')}'"
        )
        segments.append(ClipSegment(start=start, end=end, label=label))

    # Merge overlapping/adjacent segments
    if not segments:
        return segments
    segments.sort(key=lambda s: s.start)
    merged: list[ClipSegment] = [segments[0]]
    for seg in segments[1:]:
        prev = merged[-1]
        if seg.start <= prev.end:
            merged[-1] = ClipSegment(
                start=prev.start,
                end=max(prev.end, seg.end),
                label=prev.label,
            )
        else:
            merged.append(seg)
    return merged
