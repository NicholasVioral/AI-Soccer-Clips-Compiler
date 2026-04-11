"""
OCR engine for soccer scoreboard detection.

Tries two backends in order of preference:
  1. EasyOCR  — pure pip install, handles stylised broadcast fonts well
       pip install easyocr
       (downloads ~100 MB CRAFT + recognition models on first run)
  2. pytesseract — lighter wrapper around system Tesseract binary
       pip install pytesseract
       Windows installer: https://github.com/UB-Mannheim/tesseract/wiki
       Linux: apt-get install tesseract-ocr

If neither is importable the engine returns an empty result and
video_analyzer.py falls back to filename-based detection.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

# ── Optional backend detection ───────────────────────────────────────────────

try:
    import easyocr as _easyocr  # noqa: F401
    _EASYOCR_OK = True
except ImportError:
    _EASYOCR_OK = False

try:
    import pytesseract as _pytesseract  # noqa: F401
    _PYTESSERACT_OK = True
except ImportError:
    _PYTESSERACT_OK = False

try:
    import cv2 as _cv2  # noqa: F401
    _CV2_OK = True
except ImportError:
    _CV2_OK = False

# ── EasyOCR singleton (model is large; load once per process) ────────────────

_easy_reader: Any = None


def _get_easy_reader():
    global _easy_reader
    if _easy_reader is None:
        import easyocr
        log.info("Loading EasyOCR model (first-time download may take a moment)…")
        _easy_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _easy_reader


# ── Scoreboard text patterns ─────────────────────────────────────────────────

# Matches score strings like  "2-1", "0 - 0", "3–2"
_SCORE_RE = re.compile(r"\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\b")

# Matches "vs" / "v" / "VS" separators
_VS_RE = re.compile(r"\bvs\.?\b|\bversus\b", re.IGNORECASE)

# Noise tokens to discard before team-name extraction
_NOISE_TOKENS = {
    "live", "hd", "sd", "ft", "ht", "et", "aet", "pens", "pen",
    "goal", "goals", "premier", "league", "cup", "championship",
    "serie", "bundesliga", "laliga", "ligue", "eredivisie",
    "bbc", "sky", "espn", "fox", "dazn", "bt", "sport", "sports",
    "min", "mins", "minute", "minutes", "|", "·", "•",
}

# Minimum character length for a candidate team token
_MIN_TEAM_LEN = 3

# Broadcast text that regularly appears near scoreboards — discard
_BROADCAST_RE = re.compile(
    r"\b\d{1,2}:\d{2}\b"          # time "45:00"
    r"|\b\d{1,2}'\b"               # minute "45'"
    r"|[©®™]"                      # symbols
    r"|\b(?:HD|SD|4K|UHD)\b",
    re.IGNORECASE,
)


# ── Frame extraction ─────────────────────────────────────────────────────────

# Timestamps (seconds) at which to sample frames; we search early in the
# video because the scoreboard is usually visible from the first minute.
_SAMPLE_TIMESTAMPS = [2, 8, 20, 40, 60, 90, 120, 180, 300]


def extract_frames(video_path: str, max_frames: int = 6) -> list[np.ndarray]:
    """Return up to *max_frames* BGR frames from *video_path*."""
    if not _CV2_OK:
        log.warning("opencv-python-headless not installed; skipping frame extraction")
        return []

    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        log.warning("cv2 could not open video: %s", video_path)
        return []

    duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / max(
        cap.get(cv2.CAP_PROP_FPS), 1
    )

    frames: list[np.ndarray] = []
    for ts in _SAMPLE_TIMESTAMPS:
        if ts > duration:
            break
        cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
        ok, frame = cap.read()
        if ok and frame is not None:
            frames.append(frame)
        if len(frames) >= max_frames:
            break

    cap.release()
    log.debug("Extracted %d frames from %s", len(frames), video_path)
    return frames


# ── Image preprocessing ──────────────────────────────────────────────────────

def _preprocess(region: np.ndarray) -> np.ndarray:
    """
    Enhance a scoreboard crop for OCR:
      1. Grayscale
      2. 2× upscale (OCR works better on larger text)
      3. CLAHE contrast enhancement
      4. Gaussian denoise
      5. Otsu binarisation
    """
    import cv2

    if region.size == 0:
        return region

    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    gray = cv2.resize(gray, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Also keep the CLAHE-only version; some scoreboards fail on binary
    return binary


def _crop_scoreboard_regions(frame: np.ndarray) -> list[np.ndarray]:
    """Return candidate scoreboard crops (top strip, bottom strip, wide top)."""
    h, w = frame.shape[:2]
    return [
        frame[: int(h * 0.13), :],               # top 13%
        frame[int(h * 0.87) :, :],               # bottom 13%
        frame[int(h * 0.03) : int(h * 0.17),     # center-top
              int(w * 0.05) : int(w * 0.95)],
    ]


# ── OCR backends ─────────────────────────────────────────────────────────────

def _ocr_easyocr(image: np.ndarray) -> list[tuple[str, float]]:
    """Return [(text, confidence), …] using EasyOCR."""
    reader = _get_easy_reader()
    results = reader.readtext(image, detail=1, paragraph=False)
    return [(str(text), float(conf)) for (_, text, conf) in results]


def _ocr_pytesseract(image: np.ndarray) -> list[tuple[str, float]]:
    """Return [(text, confidence), …] using pytesseract."""
    import pytesseract
    from PIL import Image as PILImage

    pil_img = PILImage.fromarray(image)
    data = pytesseract.image_to_data(
        pil_img,
        config="--psm 6 --oem 3",
        output_type=pytesseract.Output.DICT,
    )
    results: list[tuple[str, float]] = []
    for text, conf in zip(data["text"], data["conf"]):
        text = text.strip()
        if text and int(conf) > 30:
            results.append((text, int(conf) / 100.0))
    return results


def _run_ocr(image: np.ndarray) -> list[tuple[str, float]]:
    """Run the best available OCR backend on *image*."""
    if _EASYOCR_OK:
        return _ocr_easyocr(image)
    if _PYTESSERACT_OK:
        processed = _preprocess(image)
        return _ocr_pytesseract(processed)
    return []


# ── Text → team name parsing ─────────────────────────────────────────────────

def _clean_token(t: str) -> str:
    t = _BROADCAST_RE.sub(" ", t).strip()
    t = re.sub(r"[^A-Za-z0-9 .'\-]", " ", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    return t


def _is_valid_team(token: str) -> bool:
    tok = token.lower().strip()
    if len(tok) < _MIN_TEAM_LEN:
        return False
    if tok in _NOISE_TOKENS:
        return False
    if re.fullmatch(r"[\d\s\-–—]+", tok):
        return False
    return True


def _extract_around_pattern(
    text: str, pattern: re.Pattern
) -> tuple[str, str] | None:
    """Split *text* around *pattern*; return (left_part, right_part) if both non-empty."""
    m = pattern.search(text)
    if not m:
        return None
    left = _clean_token(text[: m.start()])
    right = _clean_token(text[m.end() :])
    if _is_valid_team(left) and _is_valid_team(right):
        return left, right
    return None


def _parse_single_line(line: str) -> tuple[str, str] | None:
    """Try to extract two team names from a single text line."""
    # Strategy 1: split around score  "CITY 2-1 UNITED"
    result = _extract_around_pattern(line, _SCORE_RE)
    if result:
        return result

    # Strategy 2: split around "vs"  "BARCELONA vs REAL MADRID"
    result = _extract_around_pattern(line, _VS_RE)
    if result:
        return result

    return None


def _merge_texts(ocr_results: list[tuple[str, float]]) -> list[str]:
    """
    Combine OCR tokens into candidate lines.
    Returns a list of text strings to try parsing.
    """
    # Try the full concatenated string, individual long strings, and all text
    full = " ".join(t for t, _ in ocr_results)
    lines = [full]
    for text, _ in ocr_results:
        if len(text) > 6:
            lines.append(text)
    return lines


# ── Public API ───────────────────────────────────────────────────────────────

def detect_teams_from_video(video_path: str) -> dict:
    """
    Attempt to detect home/away team names by running OCR on scoreboard
    regions extracted from several frames of *video_path*.

    Returns::

        {
            "home": str | None,
            "away": str | None,
            "raw_text": str | None,   # best OCR text that led to detection
            "confidence": float,      # 0.0 – 1.0
            "backend": str,           # "easyocr" | "pytesseract" | "none"
        }
    """
    if not _CV2_OK or (not _EASYOCR_OK and not _PYTESSERACT_OK):
        log.info(
            "OCR dependencies not available; returning empty detection. "
            "Install opencv-python-headless and easyocr (or pytesseract)."
        )
        return _empty_result()

    frames = extract_frames(video_path)
    if not frames:
        return _empty_result()

    backend = "easyocr" if _EASYOCR_OK else "pytesseract"

    best: dict | None = None
    best_conf = 0.0

    for frame in frames:
        for crop in _crop_scoreboard_regions(frame):
            if crop.size == 0:
                continue
            try:
                ocr_results = _run_ocr(crop)
            except Exception as exc:
                log.debug("OCR error on crop: %s", exc)
                continue

            if not ocr_results:
                continue

            candidate_lines = _merge_texts(ocr_results)
            avg_ocr_conf = sum(c for _, c in ocr_results) / len(ocr_results)

            for line in candidate_lines:
                pair = _parse_single_line(line)
                if pair:
                    home, away = pair
                    # Weight: OCR confidence × text length heuristic
                    conf = min(avg_ocr_conf * 1.2, 1.0)
                    if conf > best_conf:
                        best_conf = conf
                        best = {
                            "home": home,
                            "away": away,
                            "raw_text": line.strip(),
                            "confidence": round(conf, 3),
                            "backend": backend,
                        }

    if best:
        log.info(
            "OCR detected teams: '%s' vs '%s' (conf=%.2f, backend=%s)",
            best["home"],
            best["away"],
            best["confidence"],
            best["backend"],
        )
        return best

    # Partial result: we ran OCR but couldn't parse two team names
    # Return the raw text so the user can at least see what was detected
    all_text = " | ".join(
        t for frame in frames
        for crop in _crop_scoreboard_regions(frame)
        for t, _ in _run_ocr(crop)
        if t.strip()
    )
    return {
        "home": None,
        "away": None,
        "raw_text": all_text[:300] if all_text else None,
        "confidence": 0.0,
        "backend": backend,
    }


def _empty_result() -> dict:
    return {
        "home": None,
        "away": None,
        "raw_text": None,
        "confidence": 0.0,
        "backend": "none",
    }
