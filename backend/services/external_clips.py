"""
External clips — download a time-range from an online video (YouTube, etc.)
with yt-dlp and store it as a self-contained MP4 that can be spliced into a
highlight reel.

The stored clip keeps its original resolution (so it previews cleanly in the
browser); it is re-scaled to match the match video's geometry later, at
reel-generation time, by clip_extractor._normalize_clip.

yt-dlp is used as a Python module (`python -m yt_dlp`) so no separate CLI
install is needed. ffmpeg must be on PATH (see clip_extractor).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import uuid

from services.clip_extractor import _run, require_ffmpeg

log = logging.getLogger(__name__)

# Hard cap on a single external clip's length. External clips are meant to be
# short inserts (a celebration, a reaction); this stops a bad start/end from
# triggering a multi-minute download.
MAX_EXTERNAL_CLIP_SECONDS = 120.0

# Prefix + extension for stored clips and their sidecar metadata. The clip id
# is "ext_<hex>"; files are "<id>.mp4" and "<id>.json".
CLIP_PREFIX = "ext_"


def ytdlp_available() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except Exception:
        return False


def _parse_time(value) -> float:
    """Accept a number of seconds or an 'M:SS' / 'H:MM:SS' string."""
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        raise ValueError("empty time")
    if ":" in s:
        parts = [float(p) for p in s.split(":")]
        total = 0.0
        for p in parts:
            total = total * 60 + p
        return total
    return float(s)


def _meta_path(clips_dir: str, clip_id: str) -> str:
    return os.path.join(clips_dir, f"{clip_id}.json")


def clip_path(clips_dir: str, clip_id: str) -> str:
    return os.path.join(clips_dir, f"{clip_id}.mp4")


def valid_clip_id(clip_id: str) -> bool:
    """Guard against path traversal — only our generated ids are allowed."""
    return (
        clip_id.startswith(CLIP_PREFIX)
        and clip_id[len(CLIP_PREFIX):].isalnum()
    )


def download_external_clip(
    url: str,
    start,
    end,
    clips_dir: str,
    label: str = "",
) -> dict:
    """
    Download [start, end] of ``url`` and store it as an MP4 in ``clips_dir``.

    Returns a metadata dict: {id, label, url, start, end, duration, filename}.
    Raises ValueError for bad input, RuntimeError for download/encode failure.
    """
    require_ffmpeg()
    if not ytdlp_available():
        raise RuntimeError(
            "yt-dlp is not installed. Run:  pip install yt-dlp"
        )

    if not (isinstance(url, str) and url.lower().startswith(("http://", "https://"))):
        raise ValueError("A valid http(s) video URL is required.")

    start_s = _parse_time(start)
    end_s = _parse_time(end)
    if end_s <= start_s:
        raise ValueError("End time must be after start time.")
    duration = end_s - start_s
    if duration > MAX_EXTERNAL_CLIP_SECONDS:
        raise ValueError(
            f"Clip is {duration:.0f}s — the maximum external clip length is "
            f"{int(MAX_EXTERNAL_CLIP_SECONDS)}s."
        )
    if start_s < 0:
        raise ValueError("Start time cannot be negative.")

    os.makedirs(clips_dir, exist_ok=True)
    clip_id = f"{CLIP_PREFIX}{uuid.uuid4().hex[:10]}"
    out_path = clip_path(clips_dir, clip_id)

    with tempfile.TemporaryDirectory() as tmpdir:
        # Download only the requested section. --force-keyframes-at-cuts makes
        # the cut frame-accurate (yt-dlp re-encodes the boundary GOPs) instead
        # of snapping to the nearest keyframe, which could start a second early.
        section = f"*{start_s:.3f}-{end_s:.3f}"
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "-f", "bv*[height<=1080]+ba/b[height<=1080]",
            "--download-sections", section,
            "--force-keyframes-at-cuts",
            "--no-playlist",
            "--no-warnings",
            "-o", os.path.join(tmpdir, "raw.%(ext)s"),
            url,
        ]
        log.info("Downloading external clip %s [%s]", url, section)
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            raise RuntimeError(
                "Video download failed:\n"
                + result.stderr.decode(errors="replace")[-800:]
            )

        raw_files = [
            os.path.join(tmpdir, f)
            for f in os.listdir(tmpdir)
            if f.startswith("raw.")
        ]
        if not raw_files:
            raise RuntimeError("Download produced no file — check the URL.")
        raw_path = raw_files[0]

        # Re-encode to a clean H.264/AAC MP4 at the source resolution. -t is a
        # safety cap; the section download is already trimmed to ~duration.
        _run([
            "ffmpeg", "-y",
            "-i", raw_path,
            "-t", f"{duration:.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart",
            out_path,
        ])

    meta = {
        "id": clip_id,
        "label": label or "External clip",
        "url": url,
        "start": start_s,
        "end": end_s,
        "duration": round(duration, 3),
        "filename": os.path.basename(out_path),
    }
    with open(_meta_path(clips_dir, clip_id), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return meta


def delete_external_clip(clips_dir: str, clip_id: str) -> bool:
    """Remove a stored clip and its metadata. Returns True if anything existed."""
    removed = False
    for p in (clip_path(clips_dir, clip_id), _meta_path(clips_dir, clip_id)):
        if os.path.isfile(p):
            os.remove(p)
            removed = True
    return removed
