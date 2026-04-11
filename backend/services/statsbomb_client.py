"""
StatsBomb open-data client.

All data is fetched from StatsBomb's public GitHub via the statsbombpy library.
No API key is required for the free open dataset.

Caching strategy
----------------
statsbombpy re-downloads data from GitHub on every call.  We apply a simple
in-process TTL cache so that repeated searches and event fetches within a
session don't hammer GitHub and return instantly after the first fetch.

Cache lifetime: CACHE_TTL_SECONDS (default 30 minutes).  For a dev server
that restarts frequently this is fine; bump to hours for a longer-lived process.
"""

from __future__ import annotations

import time
from typing import Any

import pandas as pd
from statsbombpy import sb

# ---------------------------------------------------------------------------
# Simple TTL cache
# ---------------------------------------------------------------------------

CACHE_TTL_SECONDS = 1800  # 30 minutes

_cache: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str) -> Any | None:
    entry = _cache.get(key)
    if entry and (time.time() - entry[0]) < CACHE_TTL_SECONDS:
        return entry[1]
    return None


def _cache_set(key: str, value: Any) -> None:
    _cache[key] = (time.time(), value)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _extract_name(value: Any) -> str | None:
    """Unwrap the {'id': x, 'name': y} dicts statsbombpy returns for many cols."""
    if isinstance(value, dict):
        return value.get("name")
    return value if pd.notna(value) else None


def _extract_location(value: Any) -> list[float] | None:
    """Return [x, y] from a list/tuple, or None."""
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return [float(value[0]), float(value[1])]
        except (TypeError, ValueError):
            return None
    return None


def _match_seconds(minute: int | None, second: int | None) -> int:
    """
    Convert StatsBomb minute + second to absolute match seconds.

    StatsBomb uses cumulative minutes across periods (period 2 starts at ~45,
    extra time at ~90 / ~105) so a simple multiplication is accurate.
    """
    return (minute or 0) * 60 + (second or 0)


def _safe_int(val: Any) -> int | None:
    try:
        return int(val) if pd.notna(val) else None
    except (TypeError, ValueError):
        return None


def _safe_float(val: Any) -> float | None:
    try:
        return float(val) if pd.notna(val) else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Sub-event extractors (shot, pass, dribble, carry, foul, goalkeeper)
# ---------------------------------------------------------------------------

def _extract_shot(row: pd.Series) -> dict | None:
    """Pull shot-specific fields if present."""
    outcome = _extract_name(row.get("shot_outcome"))
    if outcome is None:
        return None
    return {
        "outcome": outcome,
        "technique": _extract_name(row.get("shot_technique")),
        "body_part": _extract_name(row.get("shot_body_part")),
        "statsbomb_xg": _safe_float(row.get("shot_statsbomb_xg")),
        "end_location": _extract_location(row.get("shot_end_location")),
        "first_time": bool(row.get("shot_first_time")) if pd.notna(row.get("shot_first_time", float("nan"))) else None,
        "one_on_one": bool(row.get("shot_one_on_one")) if pd.notna(row.get("shot_one_on_one", float("nan"))) else None,
    }


def _extract_pass(row: pd.Series) -> dict | None:
    recipient = _extract_name(row.get("pass_recipient"))
    outcome = _extract_name(row.get("pass_outcome"))
    if recipient is None and outcome is None:
        return None
    return {
        "recipient": recipient,
        "outcome": outcome,                        # None = complete
        "length": _safe_float(row.get("pass_length")),
        "angle": _safe_float(row.get("pass_angle")),
        "height": _extract_name(row.get("pass_height")),
        "end_location": _extract_location(row.get("pass_end_location")),
        "type": _extract_name(row.get("pass_type")),
        "technique": _extract_name(row.get("pass_technique")),
        "body_part": _extract_name(row.get("pass_body_part")),
        "switch": bool(row.get("pass_switch")) if pd.notna(row.get("pass_switch", float("nan"))) else None,
        "through_ball": bool(row.get("pass_through_ball")) if pd.notna(row.get("pass_through_ball", float("nan"))) else None,
        "cross": bool(row.get("pass_cross")) if pd.notna(row.get("pass_cross", float("nan"))) else None,
    }


def _extract_dribble(row: pd.Series) -> dict | None:
    outcome = _extract_name(row.get("dribble_outcome"))
    if outcome is None:
        return None
    return {
        "outcome": outcome,
        "overrun": bool(row.get("dribble_overrun")) if pd.notna(row.get("dribble_overrun", float("nan"))) else None,
        "nutmeg": bool(row.get("dribble_nutmeg")) if pd.notna(row.get("dribble_nutmeg", float("nan"))) else None,
    }


def _extract_carry(row: pd.Series) -> dict | None:
    end_loc = _extract_location(row.get("carry_end_location"))
    return {"end_location": end_loc} if end_loc else None


def _extract_foul(row: pd.Series) -> dict | None:
    foul_type = _extract_name(row.get("foul_committed_type"))
    card = _extract_name(row.get("bad_behaviour_card")) or _extract_name(row.get("foul_committed_card"))
    if foul_type is None and card is None:
        return None
    return {"type": foul_type, "card": card}


def _extract_goalkeeper(row: pd.Series) -> dict | None:
    action = _extract_name(row.get("goalkeeper_type"))
    if action is None:
        return None
    return {
        "action": action,
        "outcome": _extract_name(row.get("goalkeeper_outcome")),
        "technique": _extract_name(row.get("goalkeeper_technique")),
        "position": _extract_name(row.get("goalkeeper_position")),
        "body_part": _extract_name(row.get("goalkeeper_body_part")),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_competitions() -> list[dict]:
    cached = _cache_get("competitions")
    if cached is not None:
        return cached

    df: pd.DataFrame = sb.competitions()
    result = df.sort_values(
        ["competition_name", "season_name"]
    ).to_dict(orient="records")

    _cache_set("competitions", result)
    return result


def get_matches(competition_id: int, season_id: int) -> list[dict]:
    key = f"matches:{competition_id}:{season_id}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    df: pd.DataFrame = sb.matches(
        competition_id=competition_id, season_id=season_id
    )
    result = df.sort_values("match_date").to_dict(orient="records")

    _cache_set(key, result)
    return result


def search_matches(team: str = "", competition: str = "") -> list[dict]:
    """
    Search all StatsBomb open-data competitions for matches by team name
    and/or competition name.

    Team matching uses a two-pass strategy so that OCR abbreviations like
    "MAN CITY" or "BARCA" still surface "Manchester City" / "Barcelona":

      Pass 1 — exact substring  (fast, used when query looks like a full name)
      Pass 2 — fuzzy token ratio via rapidfuzz  (slower but handles abbreviations)

    Fuzzy matching requires ``pip install rapidfuzz``; if unavailable the
    function silently falls back to substring-only matching.

    Returns a list of match summaries sorted by match_date descending,
    each carrying a ``match_score`` field (0–100) for frontend ranking.
    """
    if not team and not competition:
        raise ValueError("Provide at least one of: team, competition")

    team_q = team.lower().strip()
    comp_q = competition.lower().strip()

    # Attempt to import rapidfuzz once per process
    _fuzzy_scorer = _get_fuzzy_scorer()

    comps = get_competitions()  # cached after first call
    results: list[dict] = []

    for comp in comps:
        comp_name: str = comp.get("competition_name", "")
        season_name: str = comp.get("season_name", "")

        if comp_q and comp_q not in comp_name.lower():
            continue

        competition_id = int(comp["competition_id"])
        season_id = int(comp["season_id"])

        try:
            matches_key = f"matches:{competition_id}:{season_id}"
            matches_list = _cache_get(matches_key)
            if matches_list is None:
                matches_df: pd.DataFrame = sb.matches(
                    competition_id=competition_id, season_id=season_id
                )
                matches_list = matches_df.to_dict(orient="records")
                _cache_set(matches_key, matches_list)
        except Exception:
            continue

        for row in matches_list:
            home: str = str(row.get("home_team", ""))
            away: str = str(row.get("away_team", ""))

            score = _team_match_score(team_q, home, away, _fuzzy_scorer)
            if score < _FUZZY_THRESHOLD:
                continue

            results.append({
                "match_id":       _safe_int(row.get("match_id")),
                "competition":    comp_name,
                "competition_id": competition_id,
                "season":         season_name,
                "season_id":      season_id,
                "home_team":      home,
                "away_team":      away,
                "home_score":     _safe_int(row.get("home_score")),
                "away_score":     _safe_int(row.get("away_score")),
                "match_date":     str(row.get("match_date", "")),
                "stadium":        row.get("stadium") if isinstance(row.get("stadium"), str) else None,
                "referee":        row.get("referee") if isinstance(row.get("referee"), str) else None,
                "match_score":    score,
            })

    # Primary sort: match quality desc; secondary: date desc
    results.sort(key=lambda r: (-r["match_score"], r["match_date"]), reverse=False)
    results.sort(key=lambda r: r["match_date"], reverse=True)
    results.sort(key=lambda r: r["match_score"], reverse=True)
    return results


# ---------------------------------------------------------------------------
# Fuzzy matching helpers
# ---------------------------------------------------------------------------

_FUZZY_THRESHOLD = 60   # 0–100; scores below this are discarded
_EXACT_BONUS     = 100  # synthetic score for exact substring match

_fuzzy_scorer_cache: Any = None
_fuzzy_scorer_loaded = False


def _get_fuzzy_scorer():
    """Return a callable(query, candidate) → int(0-100), or None."""
    global _fuzzy_scorer_cache, _fuzzy_scorer_loaded
    if _fuzzy_scorer_loaded:
        return _fuzzy_scorer_cache
    _fuzzy_scorer_loaded = True
    try:
        from rapidfuzz import fuzz
        # WRatio handles abbreviations and token transpositions well
        _fuzzy_scorer_cache = fuzz.WRatio
    except ImportError:
        _fuzzy_scorer_cache = None
    return _fuzzy_scorer_cache


def _team_match_score(query: str, home: str, away: str, scorer) -> int:
    """
    Return a match quality score (0–100) for *query* against *home*/*away*.

    0 means "no match" (caller should skip this row).
    """
    if not query:
        return _EXACT_BONUS  # no team filter → all rows pass

    hl = home.lower()
    al = away.lower()

    # Exact substring → perfect score
    if query in hl or query in al:
        return _EXACT_BONUS

    if scorer is None:
        return 0

    # Fuzzy score against both team names; take the best
    h_score = scorer(query, hl)
    a_score = scorer(query, al)
    return max(h_score, a_score)


def get_match_events(match_id: int) -> list[dict]:
    """
    Return all events for a match in chronological order.

    Each event includes:
    - Timing: period, minute, second, match_seconds, timestamp (within period)
    - Identity: id, index, type
    - Actors: team, player, position
    - Spatial: location [x, y]
    - Context: play_pattern, under_pressure, duration
    - Type-specific sub-event: shot, pass, dribble, carry, foul, goalkeeper
    """
    key = f"events:{match_id}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    df: pd.DataFrame = sb.events(match_id=match_id)

    # Sort chronologically: period → minute → second → index
    sort_cols = [c for c in ["period", "minute", "second", "index"] if c in df.columns]
    df = df.sort_values(sort_cols).reset_index(drop=True)

    events: list[dict] = []
    for _, row in df.iterrows():
        minute = _safe_int(row.get("minute"))
        second = _safe_int(row.get("second"))

        event: dict = {
            # --- identity ---
            "id": str(row["id"]) if "id" in row and pd.notna(row["id"]) else None,
            "index": _safe_int(row.get("index")),
            "type": _extract_name(row.get("type")),
            # --- timing ---
            "period": _safe_int(row.get("period")),
            "minute": minute,
            "second": second,
            "match_seconds": _match_seconds(minute, second),
            "timestamp": str(row["timestamp"]) if "timestamp" in row and pd.notna(row.get("timestamp")) else None,
            # --- actors ---
            "team": _extract_name(row.get("team")),
            "player": _extract_name(row.get("player")),
            "position": _extract_name(row.get("position")),
            # --- spatial ---
            "location": _extract_location(row.get("location")),
            # --- context ---
            "play_pattern": _extract_name(row.get("play_pattern")),
            "under_pressure": bool(row["under_pressure"]) if "under_pressure" in row and pd.notna(row.get("under_pressure")) else None,
            "duration": _safe_float(row.get("duration")),
            # --- type-specific sub-events (None if not applicable) ---
            "shot": _extract_shot(row),
            "pass": _extract_pass(row),
            "dribble": _extract_dribble(row),
            "carry": _extract_carry(row),
            "foul": _extract_foul(row),
            "goalkeeper": _extract_goalkeeper(row),
        }
        events.append(event)

    _cache_set(key, events)
    return events


def get_match_summary(match_id: int) -> dict:
    """
    Return high-level match stats derived from events:
    shots, shots on target, goals per team, plus the raw match
    details from the competitions cache if available.
    """
    events = get_match_events(match_id)

    teams: set[str] = {e["team"] for e in events if e["team"]}
    stats: dict[str, dict] = {t: {"shots": 0, "shots_on_target": 0, "goals": 0, "passes": 0, "pass_complete": 0} for t in teams}

    for e in events:
        team = e["team"]
        if not team or team not in stats:
            continue
        etype = e["type"]

        if etype == "Shot" and e["shot"]:
            stats[team]["shots"] += 1
            outcome = (e["shot"].get("outcome") or "").lower()
            if outcome in ("goal", "saved", "saved to post", "saved off target"):
                stats[team]["shots_on_target"] += 1
            if outcome == "goal":
                stats[team]["goals"] += 1

        if etype == "Pass":
            stats[team]["passes"] += 1
            if e["pass"] and e["pass"].get("outcome") is None:  # None = complete
                stats[team]["pass_complete"] += 1

    return {
        "match_id": match_id,
        "total_events": len(events),
        "team_stats": stats,
    }
