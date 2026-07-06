"""
StatsBomb match index — a global lookup of every match in StatsBomb's open data,
keyed by date, used to tell whether an external (e.g. Footballia) match has
StatsBomb event data available.

Building the index fetches every competition-season's match list from StatsBomb
(~4k matches, a few seconds threaded), so it's cached process-wide with a long
TTL. Matching is by calendar date (± 1 day) plus fuzzy team-name comparison in
either home/away order.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import warnings
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any

log = logging.getLogger(__name__)

_INDEX_TTL = 6 * 3600  # 6 hours
_index: dict[str, list[tuple[str, str]]] | None = None
_index_time = 0.0
_index_lock = threading.Lock()

_MONTHS = {
    m: i for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June", "July",
         "August", "September", "October", "November", "December"], 1
    )
}

# Team-name tokens to drop before comparing ("Arsenal FC" ≈ "Arsenal").
_DROP_TOKENS = {
    "fc", "cf", "afc", "sc", "ac", "rsc", "cd", "ss", "ssc", "ssd", "us",
    "club", "de", "the", "cp", "as", "if", "bk", "sv", "vfb", "vfl", "fk",
}


# ── Index build ──────────────────────────────────────────────────────────────
def _build_index() -> dict[str, list[tuple[str, str]]]:
    warnings.filterwarnings("ignore")
    from statsbombpy import sb

    comps = sb.competitions().to_dict("records")

    def fetch(c: dict) -> list[dict]:
        try:
            df = sb.matches(
                competition_id=int(c["competition_id"]),
                season_id=int(c["season_id"]),
            )
            return df[["match_date", "home_team", "away_team"]].to_dict("records")
        except Exception:
            return []

    idx: dict[str, list[tuple[str, str]]] = defaultdict(list)
    with ThreadPoolExecutor(max_workers=12) as pool:
        for rows in pool.map(fetch, comps):
            for m in rows:
                date = str(m.get("match_date", ""))[:10]
                if date:
                    idx[date].append((str(m.get("home_team", "")),
                                      str(m.get("away_team", ""))))
    return dict(idx)


def get_index() -> dict[str, list[tuple[str, str]]]:
    """Return the cached StatsBomb date→matches index, building it if stale."""
    global _index, _index_time
    with _index_lock:
        if _index is None or (time.time() - _index_time) > _INDEX_TTL:
            _index = _build_index()
            _index_time = time.time()
        return _index


# ── Matching helpers ─────────────────────────────────────────────────────────
_scorer: Any = None
_scorer_loaded = False


def _get_scorer():
    global _scorer, _scorer_loaded
    if not _scorer_loaded:
        _scorer_loaded = True
        try:
            from rapidfuzz import fuzz
            _scorer = fuzz.WRatio
        except ImportError:
            _scorer = None
    return _scorer


def _norm(name: str) -> str:
    n = re.sub(r"[^a-z0-9 ]", " ", name.lower())
    n = " ".join(t for t in n.split() if t not in _DROP_TOKENS)
    return n.strip()


def _team_match(a: str, b: str) -> bool:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    scorer = _get_scorer()
    return bool(scorer and scorer(a, b) >= 82)


def _pair_match(fh: str, fa: str, sh: str, sa: str) -> bool:
    return ((_team_match(fh, sh) and _team_match(fa, sa)) or
            (_team_match(fh, sa) and _team_match(fa, sh)))


def _parse_footballia_date(s: str) -> datetime | None:
    m = re.match(r"(\w+)\s+(\d+),\s+(\d+)", s or "")
    if not m:
        return None
    month = _MONTHS.get(m.group(1))
    if not month:
        return None
    try:
        return datetime(int(m.group(3)), month, int(m.group(2)))
    except ValueError:
        return None


def _split_title(title: str) -> tuple[str, str] | None:
    parts = re.split(r"\s+vs\.?\s+", title, maxsplit=1)
    return (parts[0], parts[1]) if len(parts) == 2 else None


def has_statsbomb_data(title: str, date_str: str, idx=None) -> bool:
    """True if a match with these teams exists in StatsBomb on ~this date."""
    idx = idx if idx is not None else get_index()
    teams = _split_title(title)
    day = _parse_footballia_date(date_str)
    if not teams or not day:
        return False
    fh, fa = teams
    for delta in (0, -1, 1):
        key = (day + timedelta(days=delta)).strftime("%Y-%m-%d")
        for sh, sa in idx.get(key, ()):
            if _pair_match(fh, fa, sh, sa):
                return True
    return False


def filter_with_data(matches: list[dict]) -> list[dict]:
    """Return only the matches that have StatsBomb event data available.

    If the index can't be built (e.g. StatsBomb unreachable), raises so the
    caller can decide how to degrade rather than silently returning nothing.
    """
    idx = get_index()
    if not idx:
        raise RuntimeError("StatsBomb match index is empty.")
    return [m for m in matches
            if has_statsbomb_data(m.get("title", ""), m.get("date", ""), idx)]
