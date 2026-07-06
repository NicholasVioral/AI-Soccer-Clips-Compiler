import os

from flask import Blueprint, request, jsonify, send_file, current_app

from services.external_clips import (
    download_external_clip,
    delete_external_clip,
    clip_path,
    valid_clip_id,
    ytdlp_available,
)

external_bp = Blueprint("external", __name__)


@external_bp.route("/external-clips/check", methods=["GET"])
def check():
    """Let the frontend know whether external-clip downloads are available."""
    return jsonify({"available": ytdlp_available()}), 200


@external_bp.route("/external-clips", methods=["POST"])
def add():
    """
    POST /api/external-clips

    Body (JSON): { "url": "...", "start": 43, "end": 46, "label": "Celebration" }
    Downloads the [start, end] range and stores it. Returns the clip metadata.
    """
    data = request.get_json(force=True) or {}
    url = data.get("url", "")
    start = data.get("start")
    end = data.get("end")
    label = (data.get("label") or "").strip()

    if start is None or end is None:
        return jsonify({"error": "start and end times are required"}), 400

    clips_dir = current_app.config["EXTERNAL_FOLDER"]
    try:
        meta = download_external_clip(url, start, end, clips_dir, label=label)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(meta), 200


@external_bp.route("/external-clips/<clip_id>", methods=["GET"])
def serve(clip_id: str):
    """Serve a stored external clip inline (for in-browser preview)."""
    if not valid_clip_id(clip_id):
        return jsonify({"error": "Invalid clip id"}), 400
    path = clip_path(current_app.config["EXTERNAL_FOLDER"], clip_id)
    if not os.path.isfile(path):
        return jsonify({"error": "Clip not found"}), 404
    return send_file(path, mimetype="video/mp4")


@external_bp.route("/external-clips/<clip_id>", methods=["DELETE"])
def remove(clip_id: str):
    """Delete a stored external clip."""
    if not valid_clip_id(clip_id):
        return jsonify({"error": "Invalid clip id"}), 400
    removed = delete_external_clip(current_app.config["EXTERNAL_FOLDER"], clip_id)
    return jsonify({"deleted": removed}), 200
