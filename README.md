# Soccer Clip Compiler

A full-stack web application that automatically generates soccer highlight reels from broadcast match footage. Upload a video, sync it against StatsBomb's professional event dataset, browse every on-ball moment in the match, and export a compiled MP4 of the plays you care about — in seconds.

---

## What It Does

1. **Upload a match video** — drag-and-drop or select a file already on the server (bypasses browser upload limits for large 1080p files)
2. **Auto-identify the match** — OCR reads the scoreboard from sampled frames to detect team names, then fuzzy-matches them against the StatsBomb open dataset
3. **Sync events to video** — manually mark the kickoff time for each half, giving the app a precise video-to-match-time offset that handles halftime breaks
4. **Browse every event** — the full StatsBomb event stream (~3,500+ events per match) loads into a filterable list and seekable timeline; click any event to jump to that moment in the video
5. **Select and generate clips** — pick a player and event types (shots, passes, dribbles, etc.), set padding, and hit Generate
6. **Download** — a single compiled MP4 arrives in seconds

### Smart Clip Boundaries

Clips are not just a fixed time window around an event. The app analyzes the full event stream to find natural possession boundaries:

- **Clip start** — scans backward to find the `Ball Receipt*` that began the player's current possession, so the clip opens when the ball arrives at their feet, not seconds into their run
- **Clip end** by event type:
  - **Pass** → ends when the next player receives the ball + 2 s (you see the full pass and where it lands)
  - **Shot** → keeps a 10 s minimum so the outcome is always visible
  - **Other events** → ends at the first possession event by a different player + 1 s

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, Vite, CSS Modules |
| **Backend** | Python 3.12, Flask 3, Werkzeug |
| **Soccer data** | StatsBomb open data via `statsbombpy`, pandas |
| **Computer vision / OCR** | OpenCV (`opencv-python-headless`), Tesseract OCR via `pytesseract` |
| **Video processing** | FFmpeg — stream copy (`-c copy`), concat demuxer, HTTP range-request streaming |
| **Fuzzy matching** | `rapidfuzz` for team-name matching ("MAN CITY" → "Manchester City") |
| **API design** | REST; Vite dev proxy; CORS-enabled Flask blueprints |

---

## How It Works — Under the Hood

### Backend

```
backend/
├── app.py                  # Flask app factory, blueprint registration
├── routes/
│   ├── upload.py           # Video upload, server-file registration, streaming
│   ├── statsbomb.py        # Match search, event fetch (with 30-min TTL cache)
│   ├── clips.py            # Clip generation endpoint
│   └── video.py            # Broadcast clock scan endpoint
└── services/
    ├── clip_extractor.py   # Core: events_to_segments + generate_highlight_reel
    ├── clock_scanner.py    # OCR-based clock map builder
    ├── ocr_engine.py       # Frame extraction + Tesseract OCR
    ├── statsbomb_client.py # statsbombpy wrapper with caching
    └── video_analyzer.py   # Scoreboard OCR + filename parsing for auto-ID
```

**Clip generation pipeline (`clip_extractor.py`):**
1. For each selected event, call `_to_video_time()` to convert match seconds → video seconds using either the OCR clock map or the per-half manual offset
2. Scan backward through all events to find the `Ball Receipt*` that opened this possession (clip start)
3. Scan forward to find the natural clip end based on event type
4. FFmpeg cuts each segment using input-side `-ss` + `-c copy` (no re-encoding — 1080p clips finish in under 2 s)
5. FFmpeg concatenates all segments into one MP4 via the concat demuxer

**Broadcast clock scanner (`clock_scanner.py`):**
1. Samples 8 probe frames and tries three horizontal crop regions (top-left, top-center, top-right) to auto-detect where the broadcast clock lives
2. Samples the detected region every 15 s across the full video
3. Runs Tesseract OCR with multiple preprocessing variants (grayscale, inverted, contrast-boosted) on each frame
4. Strips whitespace and parses `MM:SS` regex — handles added time (90+3) and frozen 90:00 displays
5. Outputs a `clock_map`: a list of `{match_seconds, video_seconds}` pairs used for linear interpolation

### Frontend

```
frontend/src/
├── App.jsx                 # Root state, toVideoTime(), isSynced flag
├── components/
│   ├── UploadForm.jsx      # Drag-drop upload + server file picker
│   ├── KickoffCalibrator.jsx  # Per-half manual sync (1st half / 2nd half)
│   ├── VideoPlayer.jsx     # HTML5 video with range-request streaming
│   ├── EventTimeline.jsx   # Seekable dot timeline for all events
│   ├── EventList.jsx       # Filterable, searchable event list
│   ├── MatchSelector.jsx   # Match search + confidence-ranked results
│   └── PlayerHighlights.jsx   # Player/type filter + clip generation
└── services/
    ├── api.js              # Axios instance, all API calls
    └── clockUtils.js       # Linear interpolation for clock map
```

The `toVideoTime(matchSeconds, period)` function in `App.jsx` is the single source of truth for converting match time to video time. Every component — the timeline, event list, and clip generator — calls it. When the clock map is available it uses interpolation; otherwise it falls back to the per-half manual offset.

---

## Building It — The Process

The project started as a simple idea: StatsBomb publishes detailed event data for real matches — why not use it to automatically cut video? The challenge was that StatsBomb gives you match timestamps (minutes and seconds into the game), but a broadcast video has its own clock (it starts at 00:00 when you press record, not when the referee blows the whistle).

**The sync problem was the core engineering challenge.** The first approach was a single kickoff offset: measure how many seconds into the video the match starts, add that to every event timestamp. It worked for the first half but broke completely for the second — broadcast recordings include a halftime break of variable length that a single offset cannot account for.

The solution was **per-half calibration**: the user marks the kickoff moment for each half independently, giving the app two separate offsets. `event.period` from StatsBomb tells you which offset to apply.

A more ambitious second approach was **OCR-based automatic sync**: sample video frames every 15 seconds, read the on-screen broadcast clock with Tesseract OCR, and build a full `match_time → video_time` lookup table. This works around broadcast replays and cuts that can shift the apparent timeline. Getting it production-ready required:
- Auto-detecting which third of the screen the scoreboard appears in (it varies by broadcaster)
- Multiple OCR preprocessing variants to handle different fonts and backgrounds
- Handling added time notation (`90+3`) and the "frozen 90:00" that some broadcasts show after full time
- Extrapolating beyond the last known clock reading for events in stoppage time

**Large file handling** was another practical problem — a full-match 1080p video can be 20–40 GB, exceeding browser and proxy upload limits. The solution was a server-side file registration endpoint: place the file directly in the uploads folder, tell the app the filename, and it registers it without any data transfer.

**Clip quality** went through several iterations. The original fixed `padding_before`/`padding_after` approach produced clips that were technically correct but felt hollow — too much pre-event build-up and post-event dead air. The possession-boundary algorithm (scan backward for Ball Receipt*, scan forward for next possession event) produces clips that have clear narrative shape: the ball arrives, the action happens, the ball leaves.

---

## What I Learned

- **FFmpeg stream copy is massively underrated.** Switching from re-encoding (`libx264 ultrafast`) to `-c copy` reduced clip generation time from several minutes to under 5 seconds for 1080p footage. The trade-off is that cuts land on keyframe boundaries, but the possession-start padding hides any early-cut artifacts.

- **OCR on broadcast video is harder than it looks.** Fonts vary by broadcaster, scoreboards animate in and out, shadows and overlays corrupt pixels, and the same match can have the clock in three different positions depending on the channel. Building a robust solution required trying multiple crop regions, preprocessing variants, and regex patterns — and even then, the manual sync fallback is the more reliable production path.

- **Event-driven sports data has real semantic structure.** StatsBomb events are not just a list of timestamps — they encode a possession graph. `Ball Receipt*` → `Carry` → `Pass` → `Ball Receipt*` is a chain. Once you treat it as a graph and scan backward/forward along it, the "natural" clip boundaries emerge from the data rather than from arbitrary padding values.

- **React state architecture matters early.** The `toVideoTime()` function and `isSynced` flag started out duplicated across components. Centralizing them in `App.jsx` and passing them down as props eliminated a whole class of "why does the timeline show different times than the event list?" bugs.

- **Scope creep is real.** The project grew from "cut a clip at a timestamp" to OCR clock scanning, per-half sync, server file registration, smart possession boundaries, and a full event timeline. Each feature was motivated by a real frustration, but the cumulative complexity meant that each new feature required careful integration with the existing sync pipeline.

---

## How It Could Be Improved

### Accuracy
- **Better clock sync** — train a small object detection model to locate the scoreboard region reliably, then apply OCR only to that crop. Would eliminate the multi-region probing and handle unusual broadcast layouts
- **Optical flow for possession detection** — use computer vision on the video itself (not just event data) to detect when the ball changes direction, as a second signal for clip boundaries
- **Automatic kickoff detection** — detect the center-circle ball placement frame using CV instead of requiring manual calibration

### Features
- **Multiple videos** — support multiple video files for the same match (e.g., separate first and second half recordings), and route clips to the correct file based on `event.period`
- **Clip preview before export** — show a thumbnail or short preview of each clip in the UI before committing to a full generation run
- **Custom clip ordering** — let users reorder clips before export instead of always outputting in chronological order
- **Team filter on the timeline** — color-code events by team and allow filtering, so you can see only the home team's attacks
- **Export presets** — "Shot compilation", "Key passes", "Full press sequence" as one-click presets that pre-select event types with appropriate padding

### Scale
- **Background job queue** — long videos and large clip counts can tie up the Flask thread. Moving generation to a Celery/Redis queue with WebSocket progress updates would make the app production-ready
- **Database-backed sessions** — currently all state is in-browser. A lightweight database (SQLite or Postgres) would let users save and return to a session
- **Cloud storage** — storing uploaded videos and generated clips locally doesn't scale. S3 or equivalent would allow multiple concurrent users without disk pressure

### Data
- **Beyond StatsBomb** — StatsBomb open data covers a curated set of competitions. Integrating with Wyscout or Opta APIs would extend the app to any match
- **Custom event tagging** — let users tag moments directly in the video player ("tactical foul", "press trigger") and include those as first-class events alongside StatsBomb data

---

## Running Locally

**Requirements:** Python 3.12+, Node 18+, FFmpeg on PATH, Tesseract OCR (optional, for auto-sync)

```bash
# Backend
cd backend
pip install -r requirements.txt
python app.py

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite dev server proxies `/api` requests to Flask on port 5000.

**FFmpeg install:**
```
Windows : winget install ffmpeg
macOS   : brew install ffmpeg
Linux   : apt-get install ffmpeg
```

**Tesseract install (optional — needed for auto clock scan):**
```
Windows : winget install UB-Mannheim.TesseractOCR
macOS   : brew install tesseract
Linux   : apt-get install tesseract-ocr
```

---

## Data

This project uses [StatsBomb open data](https://github.com/statsbomb/open-data), which is freely available under the StatsBomb Open Data Licence. No API key is required.