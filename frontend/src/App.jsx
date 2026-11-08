import { useState, useRef, useCallback } from "react";
import UploadForm from "./components/UploadForm";
import HeroPreview from "./components/HeroPreview";
import FootballiaSearch from "./components/FootballiaSearch";
import MatchSelector from "./components/MatchSelector";
import VideoPlayer from "./components/VideoPlayer";
import KickoffCalibrator from "./components/KickoffCalibrator";
import EventList from "./components/EventList";
import EventTimeline from "./components/EventTimeline";
import PlayerHighlights from "./components/PlayerHighlights";
import { scanClock } from "./services/api";
import { interpolateVideoTime } from "./services/clockUtils";
import { loadSavedOffsets, saveOffsets } from "./services/syncStore"; // SYNC PERSIST (remove to disable)
import styles from "./App.module.css";

// Scan status values
const SCAN_IDLE    = "idle";
const SCAN_RUNNING = "running";
const SCAN_DONE    = "done";
const SCAN_FAILED  = "failed";

// Landing-page highlights — presentation only.
const FEATURES = [
  {
    title: "StatsBomb event sync",
    body: "Every pass, shot and card from StatsBomb open data, mapped onto your video's own clock.",
    icon: (
      <>
        <path d="M2 12h4l2.5-7 3 14 2.5-7h6" />
      </>
    ),
  },
  {
    title: "OCR clock detection",
    body: "Tesseract reads the broadcast clock frame by frame, so kickoff drift is found, not guessed.",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
  },
  {
    title: "FFmpeg clip export",
    body: "Frame-accurate cuts re-encoded with libx264, then stitched into one shareable reel.",
    icon: (
      <>
        <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
        <path d="M2.5 9h19M7.5 4.5v4.5M16.5 4.5v4.5" />
        <path d="M10 12.5l4.5 2.5-4.5 2.5z" />
      </>
    ),
  },
];

export default function App() {
  const [videoUrl, setVideoUrl]           = useState(null);
  const [videoFilename, setVideoFilename] = useState(null);
  const [matchInfo, setMatchInfo]         = useState(null);
  const [events, setEvents]               = useState([]);
  const [currentTime, setCurrentTime]     = useState(0);
  const [duration, setDuration]           = useState(0);
  const [halfOffsets, setHalfOffsets] = useState({ 1: null, 2: null });

  // Clock map from broadcast clock scanner
  const [clockMap, setClockMap]       = useState(null);   // null = not scanned yet
  const [scanStatus, setScanStatus]   = useState(SCAN_IDLE);
  const [scanError, setScanError]     = useState(null);

  const videoRef = useRef(null);

  // ── Unified video-time converter ─────────────────────────────────────────
  // All components use this instead of calling match_seconds + kickoffOffset
  // directly, so the clock-map path is automatically used when available.
  const toVideoTime = useCallback((matchSeconds, period = 1) => {
    if (clockMap && clockMap.length > 0) {
      return interpolateVideoTime(matchSeconds, clockMap, period);
    }
    // Use per-half offset — fall back to the other half if only one is set
    const offset = halfOffsets[period] ?? halfOffsets[period === 1 ? 2 : 1];
    if (offset !== null && offset !== undefined) {
      return matchSeconds + offset;
    }
    return null;
  }, [clockMap, halfOffsets]);

  const isSynced = (clockMap && clockMap.length >= 10) ||
                   halfOffsets[1] !== null || halfOffsets[2] !== null;

  const handleHalfCalibrated = useCallback((period, offset) => {
    const next = { ...halfOffsets, [period]: offset };
    setHalfOffsets(next);
    if (videoFilename) saveOffsets(videoFilename, next); // SYNC PERSIST (remove to disable)
  }, [halfOffsets, videoFilename]);

  // ── Auto-scan when a video is uploaded ──────────────────────────────────
  const startScan = useCallback(async (filename) => {
    setScanStatus(SCAN_RUNNING);
    setScanError(null);
    setClockMap(null);
    try {
      const { data } = await scanClock(filename);
      if (data.frame_count >= 10) {
        setClockMap(data.clock_map);
        setScanStatus(SCAN_DONE);
      } else {
        setScanError(
          data.frame_count === 0
            ? "No clock readings found — enter the match time manually below."
            : `Only ${data.frame_count} clock readings found — sync manually for accuracy.`
        );
        setScanStatus(SCAN_FAILED);
      }
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message ?? "Scan failed";
      setScanError(msg);
      setScanStatus(SCAN_FAILED);
    }
  }, []);

  const handleVideoUploaded = useCallback((url, info, filename) => {
    setVideoUrl(url);
    setVideoFilename(filename ?? null);
    setMatchInfo(info);
    setEvents([]);
    // SYNC PERSIST: restore saved sync for this video (remove → setHalfOffsets({ 1: null, 2: null }))
    setHalfOffsets(filename ? loadSavedOffsets(filename) : { 1: null, 2: null });
    setClockMap(null);
    setScanStatus(SCAN_IDLE);
    setScanError(null);

    // Auto-scan disabled — use manual half calibration below
  }, [startScan]);

  const handleMatchSelected = useCallback((_matchId, fetchedEvents) => {
    setEvents(fetchedEvents);
  }, []);

  const seekTo = useCallback((seconds) => {
    if (!videoRef.current || seconds == null) return;
    videoRef.current.currentTime = Math.max(0, seconds);
    videoRef.current.play();
  }, []);

  const timelineReady = events.length > 0 && isSynced;

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                 stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
              <path d="M12 4.5v15" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          </span>
          <h1>Soccer Clip Compiler</h1>
        </div>
        <p className={styles.subtitle}>StatsBomb → clock sync → FFmpeg export</p>
      </header>

      <main className={styles.main}>
        <div className={`${styles.landing} ${videoUrl ? styles.landingCompact : ""}`}>
          {!videoUrl && (
            <div className={styles.heroCopy}>
              <span className={styles.eyebrow}>
                <span className={styles.eyebrowDot} />
                StatsBomb open data
              </span>
              <h2 className={styles.heroTitle}>
                Turn a full match into a{" "}
                <span className={styles.heroAccent}>searchable event timeline</span>.
              </h2>
              <p className={styles.heroTagline}>
                Drop in a match video and it lines the events up against the broadcast
                clock — then every shot, goal and card is one click away, and any
                moment cuts straight to a clip.
              </p>
            </div>
          )}

          <div className={styles.heroGrid}>
            {/* ── Step 1: Upload ───────────────────────────────────────── */}
            <section className={styles.card}>
              <h2>1. Upload Video</h2>
              <UploadForm onVideoUploaded={handleVideoUploaded} />
              <div className={styles.orDivider}><span>or download from Footballia</span></div>
              <FootballiaSearch onVideoUploaded={handleVideoUploaded} />
            </section>

            {!videoUrl && <HeroPreview />}
          </div>

          {!videoUrl && (
            <ul className={styles.features}>
              {FEATURES.map((f) => (
                <li key={f.title} className={styles.featureCard}>
                  <span className={styles.featureIcon} aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                         stroke="currentColor" strokeWidth="1.5"
                         strokeLinecap="round" strokeLinejoin="round">
                      {f.icon}
                    </svg>
                  </span>
                  <div>
                    <h3>{f.title}</h3>
                    <p>{f.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {videoUrl && (
          <div className={styles.workspace}>
            {/* Left column: video + sync status + timeline */}
            <div className={styles.playerColumn}>
              <VideoPlayer
                videoRef={videoRef}
                src={videoUrl}
                onTimeUpdate={setCurrentTime}
                onDurationChange={setDuration}
              />

              <KickoffCalibrator
                videoRef={videoRef}
                currentTime={currentTime}
                halfOffsets={halfOffsets}
                onHalfCalibrated={handleHalfCalibrated}
                events={events}
                scanStatus={scanStatus}
                scanError={scanError}
                clockMapSize={clockMap ? clockMap.length : 0}
              />

              {timelineReady && (
                <EventTimeline
                  events={events}
                  duration={duration}
                  currentTime={currentTime}
                  toVideoTime={toVideoTime}
                  onSeek={seekTo}
                />
              )}

              {events.length > 0 && !isSynced && (
                <p className={styles.calibrationHint}>
                  &#9650; Waiting for clock sync above to enable the event
                  timeline and click-to-seek.
                </p>
              )}
            </div>

            {/* Right column: match selector + event list + player highlights */}
            <div className={styles.sideColumn}>
              {matchInfo && (
                <section className={styles.card}>
                  <h2>3. Confirm Match</h2>
                  <MatchSelector
                    matchInfo={matchInfo}
                    onMatchSelected={handleMatchSelected}
                  />
                </section>
              )}

              {events.length > 0 && (
                <div className={styles.eventSidebar}>
                  <h2>Events</h2>
                  <EventList
                    events={events}
                    currentTime={currentTime}
                    toVideoTime={toVideoTime}
                    isSynced={isSynced}
                    onSeek={seekTo}
                  />
                </div>
              )}

              {events.length > 0 && (
                <PlayerHighlights
                  events={events}
                  toVideoTime={toVideoTime}
                  clockMap={clockMap}
                  halfOffsets={halfOffsets}
                  videoFilename={videoFilename}
                  duration={duration}
                  isSynced={isSynced}
                  currentTime={currentTime}
                  onSeek={seekTo}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
