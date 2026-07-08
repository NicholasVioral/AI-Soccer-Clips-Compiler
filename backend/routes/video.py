import os
from flask import Blueprint, request, jsonify, current_app
from services.clock_scanner import scan_video_clock, scan_available, debug_frames
from services.video_sources import resolve_source

video_bp = Blueprint("video", __name__)


@video_bp.route("/video/scan-clock", methods=["POST"])
def scan_clock():
    """
    POST /api/video/scan-clock
    Body: {"filename": "barcelona_juventus.mp4"}

    Scans the video, OCRs the broadcast clock from sampled frames, and returns
    a lookup table used by the frontend to convert match time → video position.

    Returns:
        {"clock_map": [{"video_seconds": float, "match_seconds": int}, ...],
         "frame_count": int}
    """
    if not scan_available():
        return jsonify({
            "error": (
                "Clock scanning requires opencv-python and pytesseract.\n"
                "Run: python -m pip install opencv-python pytesseract\n"
                "Then install Tesseract: winget install UB-Mannheim.TesseractOCR"
            )
        }), 503

    data     = request.get_json(force=True)
    filename = data.get("filename", "")
    if not filename:
        return jsonify({"error": "filename is required"}), 400

    # Local path or hosting URL — OpenCV's VideoCapture reads HTTP directly.
    video_path = resolve_source(current_app.config["UPLOAD_FOLDER"], filename)
    if video_path is None:
        return jsonify({"error": f"Video not found: {filename}"}), 404

    try:
        clock_map = scan_video_clock(video_path)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "clock_map":   clock_map,
        "frame_count": len(clock_map),
    }), 200


@video_bp.route("/video/scan-check", methods=["GET"])
def scan_check():
    """Returns whether clock scanning dependencies are available."""
    return jsonify({"available": scan_available()}), 200


@video_bp.route("/video/scan-debug", methods=["POST"])
def scan_debug():
    """
    POST /api/video/scan-debug
    Body: {"filename": "...", "timestamps": [10, 30, 60, 120, 300]}

    Returns raw OCR text from each region at each timestamp so we can
    diagnose why the clock isn't being detected.
    """
    data       = request.get_json(force=True)
    filename   = data.get("filename", "")
    timestamps = data.get("timestamps", [10, 30, 60, 120, 300, 600, 900, 1200])

    video_path = resolve_source(current_app.config["UPLOAD_FOLDER"], filename)
    if video_path is None:
        return jsonify({"error": f"Video not found: {filename}"}), 404

    try:
        results = debug_frames(video_path, timestamps)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({"results": results}), 200
