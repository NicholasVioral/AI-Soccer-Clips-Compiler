import os
from flask import Blueprint, request, jsonify, current_app
from werkzeug.utils import secure_filename
from services.video_analyzer import analyze_video

upload_bp = Blueprint("upload", __name__)

ALLOWED_EXTENSIONS = {"mp4", "mkv", "avi", "mov", "webm"}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


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
