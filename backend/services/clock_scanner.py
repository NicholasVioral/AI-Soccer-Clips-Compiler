"""
Broadcast clock scanner.

Samples a video every N seconds, OCRs the clock from the top-left scoreboard
area, and builds a lookup table:  match_seconds → video_seconds

This lookup table lets clip generation find the exact video position for any
StatsBomb event, even when the broadcast has replay cuts that shift the clock.

Requirements
------------
  python -m pip install pytesseract opencv-python
  Windows : winget install UB-Mannheim.TesseractOCR
  macOS   : brew install tesseract
  Linux   : apt-get install tesseract-ocr
"""

from __future__ import annotations
import logging
import os
import re
import shutil
from typing import Callable

log = logging.getLogger(__name__)

# How often to sample the video (seconds).
SAMPLE_INTERVAL = 15.0

# Fraction of frame height to use as the scoreboard strip.
CLOCK_TOP = 0.22   # top 22% of height — covers scoreboards down to ~105px on 480p

# Horizontal regions to try during the calibration pass (left_frac, right_frac).
CLOCK_REGIONS = [
    (0.0,  0.30),   # top-left  (ESPN, beIN)
    (0.25, 0.60),   # top-center (Canal+, UEFA)
    (0.60, 1.00),   # top-right (Sky Sports)
]

# How many probe frames to use when auto-detecting the clock region.
REGION_PROBE_FRAMES = 8

# OCR config: single-line mode, digits and colon only
_PSM7 = "--psm 7 -c tessedit_char_whitelist=0123456789:"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _import_deps():
    """Import cv2 and pytesseract, raising a clear error if missing."""
    try:
        import cv2
    except ImportError:
        raise ImportError(
            "opencv-python not installed.\n"
            "  Run: python -m pip install opencv-python"
        )
    try:
        import pytesseract
    except ImportError:
        raise ImportError(
            "pytesseract not installed.\n"
            "  Run: python -m pip install pytesseract"
        )
    return cv2, pytesseract


def _find_tesseract(pytesseract) -> None:
    """Set the tesseract binary path if it isn't already on PATH."""
    if shutil.which("tesseract"):
        return
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expanduser(r"~\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"),
        # winget installs here on some machines
        os.path.expanduser(r"~\AppData\Local\Microsoft\WinGet\Packages\UB-Mannheim.TesseractOCR_Microsoft.Winget.Source_8wekyb3d8bbwe\tesseract.exe"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            pytesseract.pytesseract.tesseract_cmd = p
            log.info("Found tesseract at %s", p)
            return
    log.warning(
        "tesseract not found on PATH or in common locations. "
        "Install with: winget install UB-Mannheim.TesseractOCR"
    )


def _preprocess(roi, cv2, invert=False):
    """Grayscale → 3× upscale → CLAHE → Otsu threshold."""
    gray  = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray  = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    gray  = clahe.apply(gray)
    flag  = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
    _, th = cv2.threshold(gray, 0, 255, flag + cv2.THRESH_OTSU)
    return th


_PSM11 = "--psm 11 -c tessedit_char_whitelist=0123456789:"


def _ocr_roi(roi, cv2, pytesseract) -> int | None:
    """Try normal + inverted preprocessing; return match_seconds or None."""
    for invert in (False, True):
        try:
            proc = _preprocess(roi, cv2, invert)
            text = pytesseract.image_to_string(proc, config=_PSM7)
            ms   = _parse_clock(text)
            if ms is not None:
                return ms
        except Exception:
            pass
    return None


def _ocr_all_times(frame, cv2, pytesseract) -> list[int]:
    """
    Scan the full top strip with sparse-text OCR and return ALL MM:SS matches.
    Used to detect the added-time sub-timer (e.g. "3:54") when the main clock
    is frozen at 90:00.
    """
    h, w = frame.shape[:2]
    roi  = frame[: int(h * CLOCK_TOP), :]
    times = []
    for invert in (False, True):
        try:
            proc = _preprocess(roi, cv2, invert)
            text = re.sub(r"\s+", "", pytesseract.image_to_string(proc, config=_PSM11))
            for m in re.finditer(r"(\d{1,3}):(\d{2})", text):
                mins, secs = int(m.group(1)), int(m.group(2))
                if 0 <= mins <= 130 and 0 <= secs <= 59:
                    times.append(mins * 60 + secs)
        except Exception:
            pass
    return times


def _detect_region(cap, fps, duration, cv2, pytesseract):
    """
    Sample REGION_PROBE_FRAMES evenly spaced across the first half of the video
    and return the (lf, rf) region that yields the most clock readings.
    Falls back to scanning all regions per frame if none wins clearly.
    """
    probe_times = [duration * i / (REGION_PROBE_FRAMES + 1)
                   for i in range(1, REGION_PROBE_FRAMES + 1)
                   if duration * i / (REGION_PROBE_FRAMES + 1) < duration * 0.6]

    hits = {r: 0 for r in CLOCK_REGIONS}

    for ts in probe_times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(ts * fps))
        ret, frame = cap.read()
        if not ret:
            continue
        h, w = frame.shape[:2]
        top  = int(h * CLOCK_TOP)
        for (lf, rf) in CLOCK_REGIONS:
            roi = frame[:top, int(w * lf): int(w * rf)]
            ms  = _ocr_roi(roi, cv2, pytesseract)
            if ms is not None:
                hits[(lf, rf)] += 1

    best_region, best_count = max(hits.items(), key=lambda x: x[1])
    if best_count >= 2:
        log.info("Clock region detected: %.0f%%–%.0f%% (%d hits)", best_region[0]*100, best_region[1]*100, best_count)
        return best_region
    # No clear winner — fall back to trying all regions each frame
    log.info("Could not detect clock region; will try all regions per frame")
    return None


def _parse_clock(text: str) -> int | None:
    """Extract MM:SS from OCR text → total match seconds, or None."""
    # Strip spaces so "8 0:21" → "80:21" (OCR often inserts spaces in digits)
    text = re.sub(r"\s+", "", text)
    m = re.search(r"(\d{1,3}):(\d{2})", text)
    if not m:
        return None
    minutes, seconds = int(m.group(1)), int(m.group(2))
    if not (0 <= minutes <= 130):
        return None
    # Clamp seconds — OCR occasionally misreads 5→9
    if seconds > 59:
        seconds = 59
    return minutes * 60 + seconds


def _clean(results: list[dict]) -> list[dict]:
    """
    Remove clock readings inconsistent with a forward-moving clock.

    Also strips "frozen" clock entries that occur during added time — when
    the broadcast clock is stuck at 90:00 while showing +N separately, all
    those OCR readings have the same match_seconds.  Keeping them would push
    the last clock-map entry to the end of the video, breaking extrapolation
    for StatsBomb events in added time (93', 94', …).
    """
    if not results:
        return []
    out = [results[0]]
    for r in results[1:]:
        prev = out[-1]
        d_video = r["video_seconds"] - prev["video_seconds"]
        d_match = r["match_seconds"] - prev["match_seconds"]

        # Drop frozen readings: clock didn't advance over ≥10 s of video time.
        # This happens during added time when the broadcast shows 90+N.
        if d_match == 0 and d_video >= 10:
            log.debug(
                "Dropped frozen clock at %.1fs (clock stuck at %d s)",
                r["video_seconds"], r["match_seconds"],
            )
            continue

        # Allow the match clock to advance up to 3× faster than real time
        # (covers replays that jump forward) but not go backward.
        if 0 <= d_match <= d_video * 3 + 60:
            out.append(r)
        else:
            log.debug(
                "Dropped outlier at %.1fs (match Δ %+d s, video Δ %.1f s)",
                r["video_seconds"], d_match, d_video,
            )
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scan_available() -> bool:
    """Return True if the required libraries are importable."""
    try:
        _import_deps()
        return True
    except ImportError:
        return False


def scan_video_clock(
    video_path: str,
    sample_interval: float = SAMPLE_INTERVAL,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[dict]:
    """
    Scan *video_path*, OCR the broadcast clock from each sampled frame, and
    return a sorted list of::

        [{"video_seconds": float, "match_seconds": int}, ...]

    Raises ImportError if opencv / pytesseract are not installed.
    Raises RuntimeError if the video file cannot be opened.
    """
    cv2, pytesseract = _import_deps()
    _find_tesseract(pytesseract)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps          = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration     = total_frames / fps

    # Auto-detect which region of the frame contains the broadcast clock.
    best_region = _detect_region(cap, fps, duration, cv2, pytesseract)
    regions_to_scan = [best_region] if best_region else CLOCK_REGIONS

    # Build list of video times to sample
    sample_times: list[float] = []
    t = 0.0
    while t < duration:
        sample_times.append(t)
        t += sample_interval
    n = len(sample_times)

    raw: list[dict] = []

    for i, ts in enumerate(sample_times):
        frame_no = int(ts * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
        ret, frame = cap.read()
        if not ret:
            if on_progress:
                on_progress(i + 1, n)
            continue

        h, w = frame.shape[:2]
        top  = int(h * CLOCK_TOP)

        ms = None
        for (lf, rf) in regions_to_scan:
            roi = frame[:top, int(w * lf): int(w * rf)]
            ms  = _ocr_roi(roi, cv2, pytesseract)
            if ms is not None:
                break

        # If the main clock reads 90:00 exactly, check for an added-time
        # sub-timer (e.g. "3:54 +5" shown below the frozen scoreboard).
        # The sub-timer gives the true match time: 90:00 + sub.
        if ms == 5400:
            all_times = _ocr_all_times(frame, cv2, pytesseract)
            # Filter out the 90:00 reading itself; the sub-timer will be small
            sub_times = [t for t in all_times if t < 600]  # < 10 min = added time counter
            if sub_times:
                ms = 5400 + min(sub_times)  # use the smallest (most likely the counter)
                log.debug("Added time detected at %.1fs: sub-timer=%ds → match=%ds", ts, min(sub_times), ms)

        if ms is not None:
            raw.append({"video_seconds": ts, "match_seconds": ms})

        if on_progress:
            on_progress(i + 1, n)

    cap.release()

    raw.sort(key=lambda x: x["video_seconds"])
    cleaned = _clean(raw)

    log.info(
        "Clock scan: %d valid readings from %d sampled frames (%.0f s video)",
        len(cleaned), n, duration,
    )
    return cleaned


def debug_frames(video_path: str, timestamps: list) -> list[dict]:
    """
    For each timestamp, OCR every region+variant and return all raw text.
    Used to diagnose why clock detection is failing.
    """
    cv2, pytesseract = _import_deps()
    _find_tesseract(pytesseract)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    results = []

    for ts in timestamps:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(ts * fps))
        ret, frame = cap.read()
        if not ret:
            results.append({"ts": ts, "error": "no frame"})
            continue

        h, w = frame.shape[:2]
        top  = int(h * CLOCK_TOP)
        frame_results = {"ts": ts, "frame_size": f"{w}x{h}", "regions": []}

        for (lf, rf) in CLOCK_REGIONS:
            roi = frame[:top, int(w * lf): int(w * rf)]
            region_info = {"region": f"{int(lf*100)}-{int(rf*100)}%", "variants": []}
            for invert in (False, True):
                try:
                    proc = _preprocess(roi, cv2, invert)
                    text = pytesseract.image_to_string(proc, config=_PSM7).strip()
                    ms   = _parse_clock(text)
                    region_info["variants"].append({
                        "invert": invert,
                        "text": text,
                        "parsed": ms,
                    })
                except Exception as exc:
                    region_info["variants"].append({"invert": invert, "error": str(exc)})
            frame_results["regions"].append(region_info)

        results.append(frame_results)

    cap.release()
    return results


def interpolate_video_time(
    match_seconds: float,
    clock_map: list[dict],
) -> float | None:
    """
    Return the video position (seconds) for *match_seconds* by linearly
    interpolating between the two nearest clock-map entries.

    Returns None if *match_seconds* is outside the scanned range or the map
    is empty.
    """
    if not clock_map:
        return None

    s = sorted(clock_map, key=lambda x: x["match_seconds"])

    if match_seconds < s[0]["match_seconds"]:
        return None
    if match_seconds > s[-1]["match_seconds"]:
        return None

    for i in range(len(s) - 1):
        a, b = s[i], s[i + 1]
        if a["match_seconds"] <= match_seconds <= b["match_seconds"]:
            span = b["match_seconds"] - a["match_seconds"]
            if span == 0:
                return float(a["video_seconds"])
            frac = (match_seconds - a["match_seconds"]) / span
            return a["video_seconds"] + frac * (b["video_seconds"] - a["video_seconds"])

    return float(s[-1]["video_seconds"])
