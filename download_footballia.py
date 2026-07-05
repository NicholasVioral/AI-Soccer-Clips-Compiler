"""Download full-match videos from footballia.net.

Footballia hides its video player behind a (free) login, but the actual MP4
URL is just base64-encoded inside the match page's JavaScript, and the video
file itself is served without authentication. This script fetches the match
page using your exported browser cookies, decodes the video URL(s), and
downloads them with a live progress bar.

Usage:
    python download_footballia.py <match-url> [-o output.mp4] [--probe]

Examples:
    python download_footballia.py https://footballia.net/matches/everton-fc-arsenal-fc-premier-league-2004-2005
    python download_footballia.py <url> -o everton_arsenal.mp4
    python download_footballia.py <url> --probe   # just print the video URL(s)

Setup (one time):
    1. Create a free account at footballia.net and sign in in your browser.
    2. Export cookies with the "Get cookies.txt LOCALLY" Chrome extension
       while on any footballia.net page.
    3. Save the export as footballia.net_cookies.txt next to this script
       (or pass --cookies <path>).
"""

import argparse
import base64
import os
import re
import sys
import time
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
DEFAULT_COOKIES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "footballia.net_cookies.txt")


def load_cookie_header(cookies_path):
    """Build a Cookie header from a Netscape cookies.txt file.

    Parsed by hand: http.cookiejar re-quotes some cookie values, which
    footballia's session cookie doesn't survive.
    """
    if not os.path.exists(cookies_path):
        print(f"Warning: cookie file not found at {cookies_path} — "
              "the match page may not reveal the video without a login session.")
        return ""
    cookies = {}
    for line in open(cookies_path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) >= 7:
            cookies[fields[5]] = fields[6]
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


def fetch(url, cookie_header=""):
    headers = {"User-Agent": USER_AGENT}
    if cookie_header:
        headers["Cookie"] = cookie_header
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=headers), timeout=30)


def extract_video_urls(match_url, cookie_header):
    with fetch(match_url, cookie_header) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    urls = []
    # The player is set up as: var video = new Video("<base64, with literal \n escapes>")
    for blob in re.findall(r'new Video\("(.*?)"\)', html, re.S):
        b64 = blob.replace("\\n", "").replace("\n", "").replace("\r", "")
        b64 += "=" * (-len(b64) % 4)
        try:
            urls.append(base64.b64decode(b64).decode())
        except Exception:
            pass

    if not urls and "Sign up" in html:
        sys.exit("No video found — the page looks logged-out. "
                 "Re-export your footballia.net cookies and try again.")
    return urls


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


def download(url, out_path):
    with fetch(url) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        start = time.time()
        last_print = 0.0
        with open(out_path, "wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                now = time.time()
                if now - last_print >= 0.25 or done == total:
                    last_print = now
                    elapsed = now - start
                    speed = done / elapsed if elapsed > 0 else 0
                    pct = f"{done / total * 100:5.1f}%" if total else "  ?  "
                    eta = ((total - done) / speed) if (total and speed) else 0
                    sys.stdout.write(
                        f"\r  {pct}  {human_size(done)} / {human_size(total)}"
                        f"  {human_size(speed)}/s  elapsed {elapsed:4.0f}s"
                        f"  eta {eta:3.0f}s   ")
                    sys.stdout.flush()
        print()
    if total and done != total:
        sys.exit(f"Download incomplete: got {done} of {total} bytes.")
    print(f"  Saved {out_path} ({human_size(done)}) "
          f"in {time.time() - start:.0f}s")


def main():
    ap = argparse.ArgumentParser(description="Download a match video from footballia.net")
    ap.add_argument("match_url", help="footballia.net match page URL")
    ap.add_argument("-o", "--output", help="output filename (default: name from the video URL)")
    ap.add_argument("--cookies", default=DEFAULT_COOKIES,
                    help="Netscape-format cookies.txt for footballia.net")
    ap.add_argument("--probe", action="store_true",
                    help="print the decoded video URL(s) without downloading")
    args = ap.parse_args()

    cookie_header = load_cookie_header(args.cookies)
    urls = extract_video_urls(args.match_url, cookie_header)
    if not urls:
        sys.exit("No video URL found in the page.")

    print(f"Found {len(urls)} video file(s):")
    for u in urls:
        print(f"  {u}")
    if args.probe:
        return

    for i, url in enumerate(urls):
        name = args.output or os.path.basename(url.split("?")[0])
        if args.output and len(urls) > 1:
            root, ext = os.path.splitext(args.output)
            name = f"{root}_part{i + 1}{ext}"
        print(f"Downloading {name}")
        download(url, name)


if __name__ == "__main__":
    main()
