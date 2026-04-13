import React, { useCallback, useState, useMemo } from "react";
import styles from "./KickoffCalibrator.module.css";

const FRAME_S = 1 / 30;

const PERIOD_LABEL = { 1: "1st half", 2: "2nd half", 3: "Extra time 1", 4: "Extra time 2" };

function formatVideoTime(seconds) {
  if (seconds == null || isNaN(seconds)) return "--:--.---";
  const abs = Math.abs(seconds);
  const h   = Math.floor(abs / 3600);
  const m   = Math.floor((abs % 3600) / 60);
  const s   = Math.floor(abs % 60);
  const ms  = Math.round((abs % 1) * 1000);
  const sign = seconds < 0 ? "−" : "";
  return sign + (h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms).padStart(3,"0")}`
    : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms).padStart(3,"0")}`);
}

function formatOffset(seconds) {
  if (seconds == null || isNaN(seconds)) return "--";
  const sign = seconds < 0 ? "−" : "+";
  const abs  = Math.abs(seconds);
  const m    = Math.floor(abs / 60);
  const s    = Math.floor(abs % 60);
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

function stepVideo(videoRef, delta) {
  if (!videoRef.current) return;
  const v = videoRef.current;
  v.pause();
  v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + delta));
}

// ── Single-half calibration row ───────────────────────────────────────────────

function HalfCalibrator({ period, label, offset, onCalibrated, videoRef, currentTime, presets }) {
  const [minute, setMinute]   = useState(period === 2 ? 45 : 0);
  const [second, setSecond]   = useState(0);
  const [confirming, setConf] = useState(false);
  const isSet = offset !== null && offset !== undefined;

  const handleSet = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    const matchSeconds = minute * 60 + second;
    const off = videoRef.current.currentTime - matchSeconds;
    onCalibrated(period, off);
    setConf(true);
    setTimeout(() => setConf(false), 1800);
  }, [videoRef, minute, second, period, onCalibrated]);

  const handleReset = useCallback(() => onCalibrated(period, null), [period, onCalibrated]);

  return (
    <div className={styles.halfRow}>
      <div className={styles.halfHeader}>
        <span className={styles.halfLabel}>{label}</span>
        {isSet && (
          <span className={styles.halfBadge}>
            ✓ set · offset {formatOffset(offset)}
          </span>
        )}
      </div>

      {isSet ? (
        <div className={styles.halfSynced}>
          <span className={styles.halfSyncedText}>
            Video <strong>{formatVideoTime(currentTime)}</strong> = match{" "}
            <strong>
              {Math.floor((currentTime - offset) / 60)}:
              {String(Math.round((currentTime - offset) % 60)).padStart(2, "0")}
            </strong>
          </span>
          <button className={styles.remarkLink} onClick={handleReset}>Re-sync</button>
        </div>
      ) : (
        <div className={styles.halfForm}>
          {/* Presets */}
          <div className={styles.presets}>
            {presets.map((p) => (
              <button key={p.label} className={styles.preset}
                onClick={() => { setMinute(p.minute); setSecond(p.second); }}>
                {p.label}
              </button>
            ))}
          </div>

          <div className={styles.matchTimeRow}>
            <span className={styles.matchTimeLabel}>Match time at this frame:</span>
            <div className={styles.matchTimeInputs}>
              <input type="number" className={styles.timeInput}
                min="0" max="130" value={minute}
                onChange={(e) => setMinute(Math.min(130, Math.max(0, parseInt(e.target.value) || 0)))} />
              <span className={styles.timeSep}>:</span>
              <input type="number" className={styles.timeInput}
                min="0" max="59" value={second}
                onChange={(e) => setSecond(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))} />
              <span className={styles.timeSepLabel}>MM : SS</span>
            </div>
          </div>

          <div className={styles.controls}>
            <div className={styles.group}>
              <button className={styles.stepBtn} onClick={() => stepVideo(videoRef, -5)}>−5s</button>
              <button className={styles.stepBtn} onClick={() => stepVideo(videoRef, -1)}>−1s</button>
            </div>
            <div className={styles.group}>
              <button className={`${styles.stepBtn} ${styles.frameBtn}`} onClick={() => stepVideo(videoRef, -FRAME_S)}>◀ 1f</button>
              <button className={`${styles.stepBtn} ${styles.frameBtn}`} onClick={() => stepVideo(videoRef,  FRAME_S)}>1f ▶</button>
            </div>
            <div className={styles.group}>
              <button className={styles.stepBtn} onClick={() => stepVideo(videoRef,  1)}>+1s</button>
              <button className={styles.stepBtn} onClick={() => stepVideo(videoRef,  5)}>+5s</button>
            </div>
            <div className={styles.clock}>{formatVideoTime(currentTime)}</div>
            {confirming
              ? <span className={styles.confirmed}>✓ Synced!</span>
              : <button className={styles.markBtn} onClick={handleSet}>Set Reference</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function KickoffCalibrator({
  videoRef,
  currentTime,
  halfOffsets = { 1: null, 2: null },
  onHalfCalibrated,
  events = [],
  scanStatus = "idle",
  scanError  = null,
  clockMapSize = 0,
}) {
  const autoSynced  = scanStatus === "done" && clockMapSize >= 10;
  const [showManual, setShowManual] = useState(false);

  // Build period-specific presets from StatsBomb Kick Off events
  const presetsByPeriod = useMemo(() => {
    const kickoffs = events.filter((e) => e.type === "Kick Off");
    const byPeriod = {};
    for (const p of [1, 2, 3, 4]) {
      const ko = kickoffs.find((e) => e.period === p);
      byPeriod[p] = ko
        ? [{ label: `${PERIOD_LABEL[p]} kickoff (${ko.minute}')`, minute: ko.minute, second: ko.second ?? 0 }]
        : [{ label: `${PERIOD_LABEL[p]} kickoff`, minute: p === 1 ? 0 : p === 2 ? 45 : p === 3 ? 90 : 105, second: 0 }];
    }
    return byPeriod;
  }, [events]);

  // ── Scanning ──────────────────────────────────────────────────────────────
  if (scanStatus === "running") {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.stepLabel}>Step 2</span>
          <h3 className={styles.title}>Sync Video to Match Clock</h3>
        </div>
        <div className={styles.scanningRow}>
          <span className={styles.spinner} />
          <span className={styles.scanningText}>Scanning broadcast clock… this takes ~30–60 seconds</span>
        </div>
      </div>
    );
  }

  if (autoSynced && !showManual) {
    return (
      <div className={`${styles.panel} ${styles.done}`}>
        <div className={styles.header}>
          <span className={styles.stepLabel}>Step 2</span>
          <h3 className={styles.title}>Sync Video to Match Clock</h3>
          <span className={styles.badge}>✓ Auto-synced</span>
        </div>
        <p className={styles.instructions}>
          Broadcast clock scanned automatically —{" "}
          <strong>{clockMapSize} reference frames</strong> captured. Clips will
          land at the correct time even across broadcast cuts.
        </p>
        <button className={styles.remarkLink} onClick={() => setShowManual(true)}>
          Override with manual sync
        </button>
      </div>
    );
  }

  const anySynced = halfOffsets[1] !== null || halfOffsets[2] !== null;

  return (
    <div className={`${styles.panel} ${anySynced ? styles.done : ""}`}>
      <div className={styles.header}>
        <span className={styles.stepLabel}>Step 2</span>
        <h3 className={styles.title}>Sync Video to Match Clock</h3>
        {anySynced && <span className={styles.badge}>✓ Synced</span>}
      </div>

      {scanStatus === "failed" && scanError && (
        <p className={styles.tip}>{scanError}</p>
      )}

      <p className={styles.tip}>
        ⚠ Use <strong>StatsBomb match time</strong>, not the broadcast clock. Scrub to the
        kickoff of each half, enter the match time shown, and click <strong>Set Reference</strong>.
        Set both halves for a full-match video with a halftime break.
      </p>

      <HalfCalibrator
        period={1}
        label="1st Half"
        offset={halfOffsets[1]}
        onCalibrated={onHalfCalibrated}
        videoRef={videoRef}
        currentTime={currentTime}
        presets={presetsByPeriod[1] || []}
      />

      <HalfCalibrator
        period={2}
        label="2nd Half"
        offset={halfOffsets[2]}
        onCalibrated={onHalfCalibrated}
        videoRef={videoRef}
        currentTime={currentTime}
        presets={presetsByPeriod[2] || []}
      />
    </div>
  );
}
