"""
Clip extractor — cuts event-timed segments from a video and concatenates
them into a single highlight reel using FFmpeg.

FFmpeg must be installed and on PATH:
  Windows : winget install ffmpeg
  macOS   : brew install ffmpeg
  Linux   : apt-get install ffmpeg
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from typing import Callable

log = logging.getLogger(__name__)

# Seconds of lead-in before the player receives the ball. A little pre-roll is
# cheap insurance: if the reception isn't the exact instant they get the ball on
# screen, we'd rather start slightly early than miss the start of the action.
START_LEAD_IN = 1.5

# Seconds to keep rolling past the event that ends the clip (the next on-screen
# action). Small so the clip stops almost the instant the new event begins,
# with just enough tail to avoid a jarring hard cut.
CLIP_TAIL = 0.5

# Floor so a clip still has substance when the next event lands almost
# instantly. Deliberately small — the next event drives the real end; a large
# floor is what makes clips overrun the action.
MIN_CLIP_AFTER = 2.0

# Events skipped when looking for "the next event" that ends a clip. "Pressure"
# is a constant off-ball defensive annotation, not a new on-screen action — if
# it ended clips they'd cut ~half a second in whenever a defender closes down.
END_IGNORE_EVENTS = frozenset({"Pressure"})


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
    # Re-encode each clip rather than stream-copy. A -c copy cut can only start
    # on a keyframe, so cutting mid-GOP leaves the clip beginning with delta
    # frames that reference data outside the cut — the player shows a frozen or
    # smeared frame until the next keyframe (the "small freeze" at clip starts,
    # and stutter at concat joins). Re-encoding forces a fresh keyframe at the
    # exact start and gives every clip identical, clean timestamps so they join
    # seamlessly. -ss before -i still seeks fast to the nearest keyframe; the
    # decoder then re-encodes from the precise start, so the cut stays accurate.
    _run([
        "ffmpeg", "-y",
        "-ss", f"{max(start, 0):.3f}",
        "-i", video_path,
        "-t",  f"{max(duration, 0.5):.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-avoid_negative_ts", "make_zero",
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


def _probe_geometry(path: str) -> tuple[int, int, float]:
    """Return (width, height, fps) of a video's first stream."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-of", "json", path,
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path}")
    stream = json.loads(result.stdout.decode(errors="replace"))["streams"][0]
    width = int(stream["width"])
    height = int(stream["height"])
    num, _, den = stream.get("r_frame_rate", "30/1").partition("/")
    try:
        fps = float(num) / float(den) if float(den) else 30.0
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    return width, height, (fps if fps > 0 else 30.0)


def _normalize_clip(src: str, out: str, width: int, height: int, fps: float) -> None:
    """
    Re-encode ``src`` to exactly match the reel's geometry so it can be
    concatenated with the match-video clips using a stream copy. The clip is
    scaled to fit inside width×height (preserving aspect) and letterbox-padded,
    with square pixels and a constant frame rate, matching the encoder settings
    _cut_clip uses for the event clips.
    """
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
        f"fps={fps:.3f}"
    )
    _run([
        "ffmpeg", "-y",
        "-i", src,
        "-vf", vf,
        "-r", f"{fps:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        out,
    ])


def generate_highlight_reel(
    video_path: str,
    segments: list[ClipSegment],
    output_dir: str,
    on_progress: Callable[[int, int], None] | None = None,
    external_clips: list[str] | None = None,
    external_placement: str = "end",
) -> str:
    """
    Cut each segment and concatenate into one MP4.

    ``external_clips`` are paths to already-downloaded clip files (e.g. a
    YouTube celebration) to splice into the reel. They are normalized to the
    match video's geometry so they join the event clips seamlessly, and placed
    either before ("start") or after ("end") the event clips, keeping the order
    they were given in.

    Returns the absolute path of the output file.
    """
    require_ffmpeg()

    external_clips = external_clips or []
    if not segments and not external_clips:
        raise ValueError("No segments provided.")
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    output_path = os.path.join(output_dir, f"highlights_{uuid.uuid4().hex[:10]}.mp4")

    with tempfile.TemporaryDirectory() as tmpdir:
        event_paths: list[str] = []

        for i, seg in enumerate(segments):
            clip_path = os.path.join(tmpdir, f"clip_{i:04d}.mp4")
            log.info("Cutting %d/%d — %s", i + 1, len(segments), seg.label)
            try:
                _cut_clip(video_path, seg.start, seg.end - seg.start, clip_path)
                event_paths.append(clip_path)
            except Exception as exc:
                log.warning("Skipping clip %d: %s", i, exc)
            if on_progress:
                on_progress(i + 1, len(segments))

        # Normalize external clips to the reel's geometry (the match video's, so
        # the event clips need no re-encode). Falls back to the first external
        # clip's own geometry if there's no match video to key off.
        external_paths: list[str] = []
        if external_clips:
            try:
                target_w, target_h, target_fps = _probe_geometry(video_path)
            except Exception:
                target_w, target_h, target_fps = _probe_geometry(external_clips[0])
            for j, src in enumerate(external_clips):
                if not os.path.isfile(src):
                    log.warning("External clip missing, skipping: %s", src)
                    continue
                norm_path = os.path.join(tmpdir, f"ext_{j:04d}.mp4")
                try:
                    _normalize_clip(src, norm_path, target_w, target_h, target_fps)
                    external_paths.append(norm_path)
                except Exception as exc:
                    log.warning("Skipping external clip %s: %s", src, exc)

        if external_placement == "start":
            clip_paths = external_paths + event_paths
        else:
            clip_paths = event_paths + external_paths

        if not clip_paths:
            raise RuntimeError("All clip cuts failed — check video file and timestamps.")

        if len(clip_paths) == 1:
            shutil.move(clip_paths[0], output_path)
        else:
            _concat_clips(clip_paths, output_path)

    return output_path


# Event types that indicate a player has ball possession
POSSESSION_EVENTS = frozenset({
    "Ball Receipt*", "Carry", "Dribble", "Shot", "Pass", "Goal Keeper",
    "Dribbled Past", "Miscontrol",
})

# On-ball actions by the clipped player — used to find where their run began so
# a dribble/carry up the field before a shot is kept in the clip.
ON_BALL_EVENTS = frozenset({"Ball Receipt*", "Carry", "Dribble"})

# Events that, when performed by a *different* player, mean the ball genuinely
# changed hands, so the clip's lead-in shouldn't reach past them. Deliberately
# excludes "Dribbled Past" and "Duel": those are logged for the beaten defender
# *during* a dribble and must not cut the attacker's run short.
POSSESSION_CHANGE_EVENTS = frozenset({
    "Ball Receipt*", "Carry", "Dribble", "Pass", "Shot",
    "Miscontrol", "Goal Keeper", "Interception", "Clearance", "Ball Recovery",
})


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
    max_clip_after: float = 15.0,
) -> list[ClipSegment]:
    """
    Convert StatsBomb events → ClipSegments using context-aware boundaries.

    Clip start: scan backward for the Ball Receipt* that began this player's
    current possession (skipping non-possession events by other players such as
    Pressure). Stops scanning when another player's possession event is found.
    Falls back to padding_before if no Ball Receipt* is found.

    Clip end: stop CLIP_TAIL seconds after the first event that follows the
    clipped one, so the clip cuts the moment a new action begins (a shot's save,
    the next player on the ball, etc.). Off-ball "Pressure" annotations are
    ignored. A short MIN_CLIP_AFTER floor covers the case where that next event
    is nearly instantaneous. ``padding_after`` is retained for API compatibility
    but no longer sets the end.

    The clip end is hard-capped at ``max_clip_after`` seconds past the event.
    In open play the next action is only a second or two away, so a large gap to
    the "next action" means the ball went dead (corner, penalty, throw-in, foul,
    injury). Without this cap those clips would run until the restart is taken —
    often 20–40 s later. Capping keeps the clip to the play itself.
    """
    sorted_all = sorted(all_events or [], key=lambda e: e.get("match_seconds") or 0)

    segments: list[ClipSegment] = []
    for e in events:
        match_s = e.get("match_seconds") or 0
        period  = e.get("period") or 1
        player  = e.get("player")
        etype   = e.get("type", "")

        video_time = _to_video_time(match_s, clock_map, half_offsets, period)
        if video_time is None:
            continue
        if video_time < 0:
            continue
        if video_duration is not None and video_time > video_duration:
            continue

        # ── Clip start: begin when the player receives the ball ───────────────
        # Walk back to the player's most recent Ball Receipt* — the moment they
        # actually received the ball to start this attacking move — so the whole
        # take-on/run into the event is included. Carries/Dribbles by the player
        # and off-ball events by others (Pressure, Duel, "Dribbled Past") are
        # skipped; the earliest on-ball touch is a fallback if no reception is
        # logged (e.g. the ball was won via a tackle). The scan is bounded by the
        # possession id when available, else by another player genuinely taking
        # the ball, plus the period boundary and a lookback cap.
        #
        # Shots look back further and rely on the possession id to bound the run,
        # so a defender's touch during the dribble (a failed interception, say)
        # can't abort the search before it reaches the reception.
        possession_start_match_s = None
        this_possession = e.get("possession")
        is_shot  = etype == "Shot"
        lookback = 120.0 if is_shot else 60.0
        if player and sorted_all:
            for past in reversed(sorted_all):
                pms = past.get("match_seconds") or 0
                if pms >= match_s:
                    continue
                if pms < match_s - lookback:
                    break
                if past.get("period") != period:
                    break
                # Stay inside the event's possession when the id is available.
                ppos = past.get("possession")
                if this_possession is not None and ppos is not None and ppos != this_possession:
                    break
                ptype   = past.get("type", "")
                pplayer = past.get("player")
                if pplayer == player:
                    if ptype in ON_BALL_EVENTS:
                        possession_start_match_s = pms   # earliest touch so far
                    if ptype == "Ball Receipt*":
                        break                    # reception found — run starts here
                    # Carry / Dribble by same player → keep scanning back
                elif ptype in POSSESSION_CHANGE_EVENTS:
                    # Another player genuinely had the ball. When we have a
                    # possession id the id-change above is the real boundary, so
                    # don't abort here (the defender's touch is inside this
                    # possession); only stop on the id heuristic when it's absent.
                    if this_possession is None:
                        break
                # else: other player's non-possession event (Pressure, Duel,
                # Dribbled Past, Block, Foul…) → skip, keep scanning back

        if possession_start_match_s is not None:
            start_vt = _to_video_time(possession_start_match_s, clock_map, half_offsets, period)
            # Small lead-in so the incoming ball is visible before the reception.
            start = max(0.0, (start_vt if start_vt is not None else video_time) - START_LEAD_IN)
        else:
            start = max(0.0, video_time - padding_before)

        # ── Clip end: stop the moment the next action begins ──────────────────
        # End a hair after the first event that follows the clipped one, so the
        # clip cuts as soon as a new action starts (a shot's save, the next
        # player touching the ball, etc.). Off-ball "Pressure" annotations are
        # skipped so a defender closing down doesn't end the clip early.
        next_event_match_s = None
        for future in sorted_all:
            fms = future.get("match_seconds") or 0
            if fms <= match_s:
                continue
            if future.get("period") != period:
                break
            if fms > match_s + max_clip_after:
                break
            if future.get("type", "") in END_IGNORE_EVENTS:
                continue
            next_event_match_s = fms
            break

        # Minimum duration floor — just enough that the clip has substance when
        # the next event lands almost instantly (e.g. a shot the keeper catches
        # within a second). Keep it small or clips overrun the action.
        min_end = video_time + MIN_CLIP_AFTER

        if next_event_match_s is not None:
            end_vt = _to_video_time(next_event_match_s, clock_map, half_offsets, period)
            end = max(min_end, (end_vt + CLIP_TAIL) if end_vt is not None else min_end)
        else:
            end = min_end

        # Hard cap: never run more than max_clip_after past the event. A far-off
        # "next action" is a dead-ball stoppage (corner/penalty/throw-in), not a
        # continuation of play — don't stretch the clip to the restart. Keep the
        # per-event floor (min_end) so e.g. a Shot still shows its outcome.
        end = min(end, max(min_end, video_time + max_clip_after))

        # Manual override: the user pinned this event to a specific video time
        # (the automatic sync was off for it). Shift the whole clip so it lands
        # there, preserving the reception lead-in and tail around the event.
        override = e.get("video_time_override")
        if override is not None:
            try:
                delta = float(override) - video_time
                start = max(0.0, start + delta)
                end = end + delta
            except (TypeError, ValueError):
                pass

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
