import { useState, useRef, useCallback } from "react";
import UploadForm from "./components/UploadForm";
import MatchSelector from "./components/MatchSelector";
import VideoPlayer from "./components/VideoPlayer";
import KickoffCalibrator from "./components/KickoffCalibrator";
import EventList from "./components/EventList";
import EventTimeline from "./components/EventTimeline";
import PlayerHighlights from "./components/PlayerHighlights";
import { scanClock } from "./services/api";
import { interpolateVideoTime } from "./services/clockUtils";
import styles from "./App.module.css";

// Scan status values
const SCAN_IDLE    = "idle";
const SCAN_RUNNING = "running";
const SCAN_DONE    = "done";
const SCAN_FAILED  = "failed";

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
      return interpolateVideoTime(matchSeconds, clockMap);
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
    setHalfOffsets(prev => ({ ...prev, [period]: offset }));
  }, []);

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
    setHalfOffsets({ 1: null, 2: null });
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
        <h1>Soccer Clip Compiler</h1>
        <p className={styles.subtitle}>
          Upload a match video, sync StatsBomb events, jump to any moment.
        </p>
      </header>

      <main className={styles.main}>
        {/* ── Step 1: Upload ───────────────────────────────────────────── */}
        <section className={styles.card}>
          <h2>1. Upload Video</h2>
          <UploadForm onVideoUploaded={handleVideoUploaded} />
        </section>

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
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
