import os
from flask import Blueprint, request, jsonify, send_file, current_app
from services.clip_extractor import (
    events_to_segments,
    generate_highlight_reel,
    ffmpeg_available,
)

clips_bp = Blueprint("clips", __name__)


@clips_bp.route("/clips/check", methods=["GET"])
def check_ffmpeg():
    """Quick health-check — lets the frontend know if clip generation is available."""
    return jsonify({"ffmpeg_available": ffmpeg_available()}), 200


@clips_bp.route("/clips/generate", methods=["POST"])
def generate():
    """
    POST /api/clips/generate

    Body (JSON):
    {
        "filename":       "barcelona_juventus.mp4",  // saved upload filename
        "events":         [ { ...statsbomb event... }, ... ],
        "kickoff_offset": 45.2,   // seconds into video where match starts
        "padding_before": 5,      // seconds before the event timestamp
        "padding_after":  10,     // seconds after the event timestamp
        "video_duration": 5820    // optional — clips won't extend past this
    }

    Returns { "clip_id": "<filename>" } on success.
    The client then downloads via GET /api/clips/<clip_id>.
    """
    data = request.get_json(force=True)

    filename       = data.get("filename", "")
    events         = data.get("events", [])
    all_events     = data.get("all_events") or []  # full event list for smart clip ending
    kickoff_offset = data.get("kickoff_offset")
    clock_map      = data.get("clock_map")        # preferred over kickoff_offset
    padding_before = float(data.get("padding_before", 5))
    padding_after  = float(data.get("padding_after", 10))
    video_duration = data.get("video_duration")

    if kickoff_offset is not None:
        kickoff_offset = float(kickoff_offset)

    if not filename:
        return jsonify({"error": "filename is required"}), 400
    if not events:
        return jsonify({"error": "events list is empty"}), 400

    video_path = os.path.join(current_app.config["UPLOAD_FOLDER"], filename)
    if not os.path.isfile(video_path):
        return jsonify({"error": f"Video file not found on server: {filename}"}), 404

    segments = events_to_segments(
        events,
        kickoff_offset=kickoff_offset,
        clock_map=clock_map,
        padding_before=padding_before,
        padding_after=padding_after,
        video_duration=float(video_duration) if video_duration else None,
        all_events=all_events,
    )

    if not segments:
        return jsonify({"error": "No valid segments could be built from the provided events"}), 400

    clips_dir = current_app.config["CLIPS_FOLDER"]
    os.makedirs(clips_dir, exist_ok=True)

    try:
        output_path = generate_highlight_reel(video_path, segments, clips_dir)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    clip_id = os.path.basename(output_path)
    return jsonify({
        "clip_id":     clip_id,
        "clip_count":  len(segments),
    }), 200


@clips_bp.route("/clips/<clip_id>", methods=["GET"])
def download(clip_id: str):
    """Serve a generated highlight reel for download."""
    # Sanitise: only allow the generated filenames (no path traversal)
    if not clip_id.startswith("highlights_") or not clip_id.endswith(".mp4"):
        return jsonify({"error": "Invalid clip id"}), 400

    clip_path = os.path.join(current_app.config["CLIPS_FOLDER"], clip_id)
    if not os.path.isfile(clip_path):
        return jsonify({"error": "Clip not found"}), 404

    return send_file(
        clip_path,
        mimetype="video/mp4",
        as_attachment=True,
        download_name="highlights.mp4",
    )
