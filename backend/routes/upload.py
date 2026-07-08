import os
from flask import Blueprint, request, jsonify, current_app, send_file, redirect
from werkzeug.utils import secure_filename
from services.video_analyzer import analyze_video
from services.video_sources import list_videos, remote_manifest, resolve_source, is_url

upload_bp = Blueprint("upload", __name__)

ALLOWED_EXTENSIONS = {"mp4", "mkv", "avi", "mov", "webm"}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@upload_bp.route("/upload/list", methods=["GET"])
def list_uploads():
    """Return selectable videos: local uploads plus remotely hosted matches."""
    folder = current_app.config["UPLOAD_FOLDER"]
    return jsonify({"files": list_videos(folder, allowed_file)}), 200


@upload_bp.route("/video/stream/<path:filename>", methods=["GET"])
def stream_video(filename):
    """Stream a local video with range-request support; redirect to the
    hosting URL for videos that live off-server."""
    path = os.path.join(current_app.config["UPLOAD_FOLDER"], secure_filename(filename))
    if os.path.isfile(path):
        return send_file(path, mimetype="video/mp4", conditional=True)
    url = remote_manifest().get(filename)
    if url:
        return redirect(url, code=302)
    return jsonify({"error": "Not found"}), 404


@upload_bp.route("/upload/register", methods=["POST"])
def register_video():
    """Register a known video (local uploads folder or remote manifest) —
    no file transfer needed."""
    data     = request.get_json(force=True)
    filename = data.get("filename", "")
    if not filename:
        return jsonify({"error": "filename is required"}), 400

    source = resolve_source(current_app.config["UPLOAD_FOLDER"], filename)
    if source is None:
        return jsonify({"error": f"Unknown video: {filename}"}), 404

    # For remote sources analyze_video sees a URL, skips OCR (not a local
    # file) and falls back to filename parsing — exactly what we want, since
    # OCR-ing a remote 1 GB video on the deployed instance is impractical.
    match_info = analyze_video(source, filename)
    return jsonify({
        "message": "Video registered",
        "filename": filename,
        "match_info": match_info,
        # Direct playback URL: remote videos stream straight from the host
        # (no proxying through this server); local ones go via /video/stream.
        "video_url": source if is_url(source) else None,
    }), 200


@upload_bp.route("/upload", methods=["POST"])
def upload_video():
    if "video" not in request.files:
        return jsonify({"error": "No video file provided"}), 400

    file = request.files["video"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": f"File type not allowed. Supported: {ALLOWED_EXTENSIONS}"}), 400

    filename = secure_filename(file.filename)
    save_path = os.path.join(current_app.config["UPLOAD_FOLDER"], filename)
    file.save(save_path)

    match_info = analyze_video(save_path, filename)

    return jsonify({
        "message": "Video uploaded successfully",
        "filename": filename,
        "match_info": match_info,
    }), 200
