"""
Video analyzer — attempts to identify the soccer match in an uploaded video.

Detection pipeline (first successful method wins, rest used as fallback):

  1. OCR scoreboard  — extracts frames, reads the on-screen scoreboard
  2. Filename parse  — looks for "Team A vs Team B" or a date in the filename

The result dict is returned directly as the `match_info` JSON payload in the
/api/upload response and consumed by the frontend MatchSelector component.
"""

from __future__ import annotations

import logging
import os
import re

log = logging.getLogger(__name__)


# ── Public entry point ───────────────────────────────────────────────────────

def analyze_video(file_path: str, filename: str) -> dict:
    """
    Analyse *file_path* and return a match_info dict::

        {
            "raw_filename":    str,
            "confidence":      "ocr_high" | "ocr_medium" | "ocr_low"
                               | "filename" | "none",
            "detected_teams":  [home, away] | [],
            "detected_date":   "YYYY-MM-DD" | null,
            "ocr_raw_text":    str | null,
            "ocr_backend":     "easyocr" | "pytesseract" | "none",
            "note":            str,
        }
    """
    filename_result = _analyze_filename(filename)
    ocr_result      = _analyze_ocr(file_path)

    # Merge: prefer OCR teams if found, then filename teams
    detected_teams = ocr_result["teams"] or filename_result["teams"]

    # Confidence label
    ocr_conf = ocr_result["confidence"]      # float 0–1
    if ocr_result["teams"] and ocr_conf >= 0.75:
        confidence = "ocr_high"
    elif ocr_result["teams"] and ocr_conf >= 0.45:
        confidence = "ocr_medium"
    elif ocr_result["teams"]:
        confidence = "ocr_low"
    elif filename_result["teams"]:
        confidence = "filename"
    else:
        confidence = "none"

    note = _build_note(confidence, ocr_result)

    return {
        "raw_filename":   filename,
        "confidence":     confidence,
        "detected_teams": detected_teams,
        "detected_date":  filename_result["date"],
        "ocr_raw_text":   ocr_result["raw_text"],
        "ocr_backend":    ocr_result["backend"],
        "note":           note,
    }


# ── OCR detection ────────────────────────────────────────────────────────────

def _analyze_ocr(file_path: str) -> dict:
    """
    Run the OCR engine.  Returns a safe dict even if OCR is unavailable
    or raises an exception.
    """
    try:
        from services.ocr_engine import detect_teams_from_video
        result = detect_teams_from_video(file_path)
        teams = []
        if result.get("home") and result.get("away"):
            teams = [result["home"], result["away"]]
        elif result.get("home"):
            teams = [result["home"]]
        return {
            "teams":      teams,
            "confidence": result.get("confidence", 0.0),
            "raw_text":   result.get("raw_text"),
            "backend":    result.get("backend", "none"),
        }
    except Exception as exc:
        log.warning("OCR analysis failed: %s", exc)
        return {"teams": [], "confidence": 0.0, "raw_text": None, "backend": "none"}


# ── Filename detection ───────────────────────────────────────────────────────

def _analyze_filename(filename: str) -> dict:
    name = os.path.splitext(filename)[0]
    clean = re.sub(r"[_\-]", " ", name)
    return {
        "teams": _filename_teams(clean),
        "date":  _filename_date(clean),
    }


def _filename_teams(text: str) -> list[str]:
    """Return [home, away] if a 'vs'/'versus' separator is found."""
    pattern = re.compile(
        r"([A-Za-z][A-Za-z\s]{1,30}?)\s+(?:vs\.?|versus)\s+"
        r"([A-Za-z][A-Za-z\s]{1,30}?)(?:\s+\d{4}|$)",
        re.IGNORECASE,
    )
    m = pattern.search(text)
    if m:
        return [m.group(1).strip(), m.group(2).strip()]
    return []


def _filename_date(text: str) -> str | None:
    m = re.search(r"(\d{4})[.\-](\d{2})[.\-](\d{2})", text)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


# ── Note builder ─────────────────────────────────────────────────────────────

def _build_note(confidence: str, ocr_result: dict) -> str:
    backend = ocr_result.get("backend", "none")
    if confidence == "ocr_high":
        return (
            f"Teams identified with high confidence via OCR ({backend}). "
            "Searching StatsBomb automatically."
        )
    if confidence == "ocr_medium":
        return (
            f"Teams detected via OCR ({backend}) with moderate confidence — "
            "please verify the suggested match."
        )
    if confidence == "ocr_low":
        return (
            f"OCR ({backend}) found text but team matching is uncertain. "
            "Use manual search to confirm."
        )
    if confidence == "filename":
        return (
            "Teams inferred from filename. OCR not available or scoreboard not "
            "detected — install opencv-python-headless and easyocr for automatic "
            "identification."
        )
    return (
        "Could not detect teams automatically. "
        "Search manually using team or competition name."
    )
