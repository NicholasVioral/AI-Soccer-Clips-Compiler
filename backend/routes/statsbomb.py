from flask import Blueprint, request, jsonify
from services.statsbomb_client import (
    get_competitions,
    get_matches,
    get_match_events,
    get_match_summary,
    search_matches,
)

statsbomb_bp = Blueprint("statsbomb", __name__)


@statsbomb_bp.route("/competitions", methods=["GET"])
def competitions():
    """Return all StatsBomb open-data competitions, sorted by name."""
    return jsonify(get_competitions()), 200


@statsbomb_bp.route("/matches", methods=["GET"])
def matches():
    """
    GET /api/matches?competition_id=<int>&season_id=<int>
    Return all matches for a specific competition + season.
    """
    competition_id = request.args.get("competition_id", type=int)
    season_id = request.args.get("season_id", type=int)

    if competition_id is None or season_id is None:
        return jsonify({"error": "competition_id and season_id are required"}), 400

    return jsonify(get_matches(competition_id, season_id)), 200


@statsbomb_bp.route("/search-matches", methods=["GET"])
def search():
    """
    GET /api/search-matches?team=<str>&competition=<str>

    Search StatsBomb open data by team name and/or competition name.
    Both params are optional but at least one must be provided.
    Matches are returned sorted by match_date descending.

    Examples:
        /api/search-matches?team=Barcelona
        /api/search-matches?team=Liverpool&competition=Champions League
        /api/search-matches?competition=FIFA World Cup
    """
    team = request.args.get("team", "").strip()
    competition = request.args.get("competition", "").strip()

    # Legacy support: ?q= treated as a team search
    if not team and not competition:
        q = request.args.get("q", "").strip()
        if q:
            team = q
        else:
            return jsonify({
                "error": "Provide at least one of: team, competition (or legacy q)"
            }), 400

    try:
        results = search_matches(team=team, competition=competition)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Search failed: {str(e)}"}), 500

    return jsonify({
        "count": len(results),
        "matches": results,
    }), 200


@statsbomb_bp.route("/events", methods=["GET"])
def events():
    """
    GET /api/events?match_id=<int>

    Return all events for a match in chronological order
    (sorted by period → minute → second → index).

    Each event includes:
      id, index, type, period, minute, second, match_seconds, timestamp,
      team, player, position, location [x,y], play_pattern, under_pressure,
      duration, and type-specific sub-objects (shot, pass, dribble, carry,
      foul, goalkeeper).
    """
    match_id = request.args.get("match_id", type=int)
    if match_id is None:
        return jsonify({"error": "match_id is required"}), 400

    try:
        data = get_match_events(match_id)
    except Exception as e:
        return jsonify({"error": f"Failed to fetch events: {str(e)}"}), 500

    return jsonify({
        "match_id": match_id,
        "count": len(data),
        "events": data,
    }), 200


@statsbomb_bp.route("/events/summary", methods=["GET"])
def events_summary():
    """
    GET /api/events/summary?match_id=<int>

    Return aggregate team stats (shots, goals, pass accuracy) derived
    from event data, without returning the full event list.
    """
    match_id = request.args.get("match_id", type=int)
    if match_id is None:
        return jsonify({"error": "match_id is required"}), 400

    try:
        data = get_match_summary(match_id)
    except Exception as e:
        return jsonify({"error": f"Failed to compute summary: {str(e)}"}), 500

    return jsonify(data), 200
