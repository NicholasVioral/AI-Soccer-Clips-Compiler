"""
Footballia integration — search for a match by team, list that team's available
matches, and download the full match video into the uploads folder so the app
can use it like any other upload.

Footballia serves the actual MP4s without authentication, but the match page
only reveals the (base64-encoded) video URLs to a logged-in session. Export
your footballia.net cookies to ``footballia.net_cookies.txt`` at the project
root (see download_footballia.py for the one-time setup).

Downloads run in a background thread with progress tracked in-memory; the
frontend polls for status. (In-memory job state assumes a single server
process, which the local Flask dev server is.)
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

from werkzeug.utils import secure_filename

log = logging.getLogger(__name__)

BASE = "https://footballia.net"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Cookie file is looked for at the project root (one level above backend/) and
# in the backend dir, so it works regardless of where the app is launched from.
_HERE = os.path.dirname(os.path.abspath(__file__))
_COOKIE_CANDIDATES = [
    os.path.join(_HERE, "..", "..", "footballia.net_cookies.txt"),
    os.path.join(_HERE, "..", "footballia.net_cookies.txt"),
]

_BACKSLASH = chr(92)  # avoids escape ambiguity when stripping "\n" separators


# ── Cookies ──────────────────────────────────────────────────────────────────
def _cookie_path() -> str | None:
    for p in _COOKIE_CANDIDATES:
        if os.path.isfile(p):
            return os.path.abspath(p)
    return None


def cookies_available() -> bool:
    return _cookie_path() is not None


def _cookie_header() -> str:
    """Build a Cookie header from the Netscape cookies.txt (parsed by hand —
    http.cookiejar re-quotes footballia's session cookie and breaks it)."""
    path = _cookie_path()
    if not path:
        return ""
    cookies = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) >= 7:
                cookies[fields[5]] = fields[6]
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


# ── HTTP helpers ─────────────────────────────────────────────────────────────
def _fetch(url: str, *, ajax: bool = False, cookie: bool = True) -> str:
    headers = {"User-Agent": USER_AGENT}
    if ajax:
        headers["X-Requested-With"] = "XMLHttpRequest"
        headers["Accept"] = "application/json, text/javascript, */*; q=0.01"
    if cookie:
        ch = _cookie_header()
        if ch:
            headers["Cookie"] = ch
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    # Footballia serves UTF-8 pages but its autocomplete JSON is latin-1 —
    # decode UTF-8 first, fall back to cp1252 so accented names aren't garbled.
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


# ── Team search (autocomplete) ───────────────────────────────────────────────
def search_teams(name: str, limit: int = 10) -> list[dict]:
    """Resolve a team-name query to teams via footballia's autocomplete."""
    if not name or len(name.strip()) < 2:
        return []
    url = f"{BASE}/search_by_team?" + urllib.parse.urlencode({"name": name.strip()})
    body = _fetch(url, ajax=True)
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return []
    teams = []
    for t in data[:limit]:
        teams.append({
            "id": t.get("id"),
            "name": t.get("name") or t.get("value"),
            "slug": t.get("slug"),
            "logo": (BASE + t["logo_thumb"]) if t.get("logo_thumb") else None,
        })
    return teams


# ── Match list for a team ────────────────────────────────────────────────────
def _clean(text: str) -> str:
    import html
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text))).strip()


def list_matches(slug: str, page: int = 1) -> dict:
    """Return a page of a team's available matches (each with title, date,
    competition, stage, season) plus pagination info."""
    slug = secure_filename(slug) or slug
    url = f"{BASE}/teams/{urllib.parse.quote(slug)}?page={int(page)}"
    html = _fetch(url)

    matches = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        link = re.search(r'<a href="(/matches/[^"?#]+)">([^<]+)</a>', row)
        if not link:
            continue
        href, title = link.group(1), _clean(link.group(2))
        if not title:
            continue

        def td(cls):
            m = re.search(rf'<td class="{cls}[^"]*">(.*?)</td>', row, re.S)
            return _clean(m.group(1)) if m else ""

        matches.append({
            "url": BASE + href,
            "title": title,
            "date": td("playing_date"),
            "competition": td("competition"),
            "stage": td("stage"),
            "season": td("season"),
        })

    # Pagination: footballia links carry page=N; the largest is the last page.
    pages = [int(p) for p in re.findall(r"[?&]page=(\d+)", html)]
    total_pages = max(pages) if pages else page
    return {
        "matches": matches,
        "page": page,
        "total_pages": total_pages,
        "has_next": page < total_pages,
    }


# Cache aggregated team results — fetching every page is ~20 requests, so a
# short TTL avoids re-fetching each time the user reopens a team.
_ALL_TTL = 600  # seconds
_all_cache: dict[str, tuple[float, dict]] = {}
_all_lock = threading.Lock()


def _season_sort_key(season: str):
    """Sort seasons newest-first; e.g. '2004-2005' before '1970-1971'."""
    m = re.search(r"(\d{4})", season or "")
    return -int(m.group(1)) if m else 1  # undated seasons last


def list_all_matches(slug: str) -> dict:
    """
    Fetch every page of a team's matches and aggregate them, plus the distinct
    competitions and seasons for filtering. Cached briefly per team.

    Returns {matches, competitions, seasons, total}.
    """
    slug = secure_filename(slug) or slug
    now = time.time()
    with _all_lock:
        cached = _all_cache.get(slug)
        if cached and now - cached[0] < _ALL_TTL:
            return cached[1]

    # Page 1 drives pagination, so retry it once on a transient network hiccup
    # rather than failing the whole request.
    try:
        first = list_matches(slug, 1)
    except Exception:
        time.sleep(1)
        first = list_matches(slug, 1)
    total_pages = first["total_pages"]
    all_matches = list(first["matches"])

    if total_pages > 1:
        def fetch(p):
            try:
                return list_matches(slug, p)["matches"]
            except Exception:
                return []
        with ThreadPoolExecutor(max_workers=6) as pool:
            for extra in pool.map(fetch, range(2, total_pages + 1)):
                all_matches.extend(extra)

    competitions = sorted({m["competition"] for m in all_matches if m["competition"]})
    seasons = sorted(
        {m["season"] for m in all_matches if m["season"]},
        key=_season_sort_key,
    )
    result = {
        "matches": all_matches,
        "competitions": competitions,
        "seasons": seasons,
        "total": len(all_matches),
    }
    with _all_lock:
        _all_cache[slug] = (now, result)
    return result


# ── Video URL extraction ─────────────────────────────────────────────────────
def _decode_file(encoded: str) -> str | None:
    """Decode a playlist ``file`` value: base64 with literal ``\\n`` separators.
    Mirrors the site's `new Video(file).url()` which is just atob()."""
    parts = encoded.split(_BACKSLASH)
    joined = parts[0] + "".join(p[1:] for p in parts[1:])  # drop each escape char
    b64 = re.sub(r"[^A-Za-z0-9+/]", "", joined)
    b64 += "=" * (-len(b64) % 4)
    try:
        return base64.b64decode(b64).decode("utf-8", errors="replace")
    except Exception:
        return None


def extract_video_urls(match_url: str) -> list[str]:
    """Return the ordered MP4 URLs for a match (one per half/part)."""
    html = _fetch(match_url)
    encoded: list[str] = []
    m = re.search(r"playlist\s*=\s*(\[.*?\]);", html, re.S)
    if m:
        encoded = re.findall(r'"file"\s*:\s*"([^"]+)"', m.group(1))
    else:
        # Single-video pages have no playlist array; the video is passed
        # straight to the player as `video = new Video("<base64>")`.
        single = re.search(r'new\s+Video\(\s*"([^"]+)"\s*\)', html, re.S)
        if single:
            encoded = [single.group(1)]
    if not encoded:
        if "Sign up" in html or "sign_up" in html:
            raise RuntimeError(
                "Footballia looks logged out — re-export footballia.net_cookies.txt."
            )
        raise RuntimeError("No video found on this match page.")
    urls = []
    for enc in encoded:
        u = _decode_file(enc)
        if u and u.startswith("http"):
            urls.append(u)
    if not urls:
        raise RuntimeError("Could not decode any video URL from the match page.")
    return urls


# ── Background download jobs ──────────────────────────────────────────────────
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _set_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        _jobs.setdefault(job_id, {}).update(fields)


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def _head_size(url: str) -> int:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(r.headers.get("Content-Length", 0))
    except Exception:
        return 0


def _download_to(url: str, dest: str, job_id: str, base_done: int, total: int) -> int:
    """Stream one part to ``dest``, updating job progress. Returns bytes written."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    done = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            _set_job(job_id, downloaded=base_done + done, total=total)
    return done


def _probe_duration(path: str) -> float:
    """Media duration in seconds via ffprobe (0.0 if it can't be read)."""
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return float(res.stdout.decode().strip())
    except (ValueError, OSError):
        return 0.0


def _write_concat_list(parts: list[str]) -> str:
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fl:
        for p in parts:
            # Absolute paths: the concat demuxer resolves relative entries
            # against the list file's directory (the temp dir), not our CWD.
            abs_p = os.path.abspath(p).replace(chr(92), "/")
            fl.write(f"file '{abs_p}'\n")
        return fl.name


def _concat_parts(parts: list[str], out_path: str) -> None:
    """Join match parts into one MP4.

    Footballia halves are often separate encodes with different MP4 track
    timescales; concat-copying those directly corrupts the timestamps (a 2 h
    match reports as 7 h). So each part is first remuxed — stream copy, no
    re-encode — to a common timescale before concatenating. If the joined
    file's duration still doesn't match the sum of the parts (or the copy
    fails outright, e.g. mismatched codecs), fall back to a full re-encode.
    """
    expected = sum(_probe_duration(p) for p in parts)

    norm_parts: list[str] = []
    for p in parts:
        norm = f"{p}.norm.mp4"
        res = subprocess.run(
            ["ffmpeg", "-y", "-i", p, "-c", "copy",
             "-video_track_timescale", "90000", norm],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        norm_parts.append(norm if res.returncode == 0 else p)

    list_path = _write_concat_list(norm_parts)
    try:
        copy_cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
                    "-c", "copy", "-movflags", "+faststart", out_path]
        res = subprocess.run(copy_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # Tolerate small drift; anything beyond 5% means broken timestamps.
        duration_ok = (
            res.returncode == 0
            and (not expected
                 or abs(_probe_duration(out_path) - expected) <= max(30.0, expected * 0.05))
        )
        if not duration_ok:
            enc_cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                       "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                       "-movflags", "+faststart", out_path]
            res2 = subprocess.run(enc_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if res2.returncode != 0:
                raise RuntimeError(res2.stderr.decode(errors="replace")[-500:])
    finally:
        os.unlink(list_path)
        for n in norm_parts:
            if n.endswith(".norm.mp4") and os.path.isfile(n):
                os.remove(n)


def _worker(job_id: str, match_url: str, title: str, upload_dir: str) -> None:
    tmp_parts: list[str] = []
    upload_dir = os.path.abspath(upload_dir)
    try:
        _set_job(job_id, status="resolving")
        urls = extract_video_urls(match_url)

        total = sum(_head_size(u) for u in urls)
        _set_job(job_id, status="downloading", downloaded=0, total=total, parts=len(urls))

        base = secure_filename(title) or f"match_{job_id[:8]}"
        base = base[:80].rstrip("_") or f"match_{job_id[:8]}"

        os.makedirs(upload_dir, exist_ok=True)
        base_done = 0
        for i, u in enumerate(urls):
            part_path = os.path.join(upload_dir, f".{base}_part{i}.tmp.mp4")
            tmp_parts.append(part_path)
            base_done += _download_to(u, part_path, job_id, base_done, total)

        _set_job(job_id, status="processing")
        final_name = f"{base}.mp4"
        final_path = os.path.join(upload_dir, final_name)
        # Avoid clobbering an existing upload with the same name.
        n = 1
        while os.path.isfile(final_path):
            final_name = f"{base}_{n}.mp4"
            final_path = os.path.join(upload_dir, final_name)
            n += 1

        if len(tmp_parts) == 1:
            os.replace(tmp_parts[0], final_path)
        else:
            _concat_parts(tmp_parts, final_path)
            for p in tmp_parts:
                if os.path.isfile(p):
                    os.remove(p)

        _set_job(job_id, status="done", filename=final_name)
    except Exception as exc:
        log.exception("Footballia download failed")
        for p in tmp_parts:
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass
        _set_job(job_id, status="error", error=str(exc))


def start_download(match_url: str, title: str, upload_dir: str) -> str:
    """Kick off a background download; returns a job id to poll."""
    job_id = uuid.uuid4().hex
    _set_job(job_id, status="starting", title=title, downloaded=0, total=0)
    t = threading.Thread(
        target=_worker, args=(job_id, match_url, title, upload_dir), daemon=True
    )
    t.start()
    return job_id
