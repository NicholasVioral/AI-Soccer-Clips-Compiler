from flask import Blueprint, request, jsonify, current_app

from services.footballia import (
    cookies_available,
    search_teams,
    list_matches,
    list_all_matches,
    start_download,
    get_job,
)

footballia_bp = Blueprint("footballia", __name__)


@footballia_bp.route("/footballia/check", methods=["GET"])
def check():
    """Whether footballia integration is usable (cookies present)."""
    return jsonify({"available": cookies_available()}), 200


@footballia_bp.route("/footballia/search-teams", methods=["GET"])
def search():
    name = request.args.get("name", "")
    try:
        teams = search_teams(name)
    except Exception as exc:
        return jsonify({"error": f"Team search failed: {exc}"}), 502
    return jsonify({"teams": teams}), 200


@footballia_bp.route("/footballia/matches", methods=["GET"])
def matches():
    slug = request.args.get("slug", "")
    page = request.args.get("page", 1, type=int)
    if not slug:
        return jsonify({"error": "slug is required"}), 400
    try:
        result = list_matches(slug, page)
    except Exception as exc:
        return jsonify({"error": f"Could not load matches: {exc}"}), 502
    return jsonify(result), 200


@footballia_bp.route("/footballia/all-matches", methods=["GET"])
def all_matches():
    slug = request.args.get("slug", "")
    if not slug:
        return jsonify({"error": "slug is required"}), 400
    try:
        result = list_all_matches(slug)
    except Exception as exc:
        return jsonify({"error": f"Could not load matches: {exc}"}), 502

    all_count = result["total"]

    # Keep only matches that also have StatsBomb event data, so every match in
    # the list can actually be synced and clipped. If StatsBomb is unreachable,
    # fall back to the full list rather than showing nothing.
    from services.statsbomb_index import filter_with_data
    from services.footballia import _season_sort_key
    data_filtered = True
    try:
        matches = filter_with_data(result["matches"])
    except Exception:
        matches = result["matches"]
        data_filtered = False

    competitions = sorted({m["competition"] for m in matches if m["competition"]})
    seasons = sorted(
        {m["season"] for m in matches if m["season"]},
        key=_season_sort_key,
    )
    return jsonify({
        "matches": matches,
        "competitions": competitions,
        "seasons": seasons,
        "total": len(matches),
        "total_all": all_count,
        "data_filtered": data_filtered,
    }), 200


@footballia_bp.route("/footballia/download", methods=["POST"])
def download():
    if not cookies_available():
        return jsonify({
            "error": "No footballia.net_cookies.txt found. Export your cookies "
                     "to the project root (see download_footballia.py)."
        }), 400
    data = request.get_json(force=True) or {}
    match_url = data.get("match_url", "")
    title = (data.get("title") or "").strip()
    if not match_url.startswith("https://footballia.net/matches/"):
        return jsonify({"error": "A valid footballia match URL is required"}), 400

    job_id = start_download(match_url, title, current_app.config["UPLOAD_FOLDER"])
    return jsonify({"job_id": job_id}), 200


@footballia_bp.route("/footballia/download/<job_id>", methods=["GET"])
def download_status(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Unknown job"}), 404
    total = job.get("total") or 0
    done = job.get("downloaded") or 0
    pct = round(done / total * 100, 1) if total else 0
    return jsonify({
        "status": job.get("status"),
        "downloaded": done,
        "total": total,
        "progress": pct,
        "parts": job.get("parts"),
        "filename": job.get("filename"),
        "error": job.get("error"),
    }), 200
