"""
Video sources — resolves a video filename to something ffmpeg/OpenCV can read.

Full-match videos (~1 GB each) are far too large for the deployed server's
ephemeral disk, so they are hosted as public GitHub release assets and listed
in remote_videos.json (filename → URL). A filename resolves to the local file
in uploads/ when present (dev machines keep the originals), else to its remote
URL. ffmpeg, ffprobe and OpenCV all read HTTP(S) inputs directly via range
requests, and the frontend points the <video> element straight at the URL, so
the server never has to store or proxy the full match.
"""

from __future__ import annotations

import json
import logging
import os

log = logging.getLogger(__name__)

_MANIFEST_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "remote_videos.json",
)


def is_url(source: str) -> bool:
    return source.startswith(("http://", "https://"))


def remote_manifest() -> dict[str, str]:
    """filename → public URL for videos hosted off-server. Empty if no manifest."""
    try:
        with open(_MANIFEST_PATH, encoding="utf-8") as f:
            manifest = json.load(f)
        return {k: v for k, v in manifest.items() if isinstance(v, str) and is_url(v)}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Could not read remote_videos.json: %s", exc)
        return {}


def resolve_source(upload_folder: str, filename: str) -> str | None:
    """
    Return what ffmpeg/OpenCV should open for *filename*: the local path in
    uploads/ when the file exists there, else its remote URL, else None.
    """
    local = os.path.join(upload_folder, filename)
    if os.path.isfile(local):
        return local
    return remote_manifest().get(filename)


def list_videos(upload_folder: str, allowed: "callable") -> list[str]:
    """All selectable video filenames: local uploads plus remote manifest."""
    names = {
        f for f in os.listdir(upload_folder)
        if os.path.isfile(os.path.join(upload_folder, f)) and allowed(f)
    }
    names.update(remote_manifest().keys())
    return sorted(names)
