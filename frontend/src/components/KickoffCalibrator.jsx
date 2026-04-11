import React, { useCallback, useState, useMemo } from "react";
import styles from "./KickoffCalibrator.module.css";

const FRAME_S = 1 / 30;

// Fallback presets when no events are loaded yet
const FALLBACK_PRESETS = [
  { label: "Kickoff (0')",        minute: 0,  second: 0 },
  { label: "2nd half (45')",      minute: 45, second: 0 },
  { label: "Extra time 1 (90')",  minute: 90, second: 0 },
  { label: "Extra time 2 (105')", minute: 105, second: 0 },
];

const PERIOD_LABEL = { 1: "1st half", 2: "2nd half", 3: "Extra time 1", 4: "Extra time 2" };

function formatVideoTime(seconds) {
  if (seconds == null || isNaN(seconds)) return "--:--.---";
  const abs = Math.abs(seconds);
  const h   = Math.floor(abs / 3600);
  const m   = Math.floor((abs % 3600) / 60);
  const s   = Math.floor(abs % 60);
  const ms  = Math.round((abs % 1) * 1000);
  const mm  = String(m).padStart(2, "0");
  const ss  = String(s).padStart(2, "0");
  const mmm = String(ms).padStart(3, "0");
  const sign = seconds < 0 ? "−" : "";
  return sign + (h > 0 ? `${h}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`);
}

function formatOffset(seconds) {
  if (seconds == null || isNaN(seconds)) return "--";
  const sign = seconds < 0 ? "−" : "+";
  const abs  = Math.abs(seconds);
  const m    = Math.floor(abs / 60);
  const s    = Math.floor(abs % 60);
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

function formatMatchTime(minute, second) {
  return `${minute}:${String(second).padStart(2, "0")}`;
}

function stepVideo(videoRef, delta) {
  if (!videoRef.current) return;
  const v = videoRef.current;
  v.pause();
  v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + delta));
}

export default function KickoffCalibrator({
  videoRef,
  currentTime,
  kickoffOffset,
  onCalibrated,
  events = [],
  scanStatus = "idle",   // "idle" | "running" | "done" | "failed"
  scanError  = null,
  clockMapSize = 0,
}) {
  const [matchMinute, setMatchMinute] = useState(0);
  const [matchSecond, setMatchSecond] = useState(0);
  const [confirming, setConfirming]   = useState(false);
  // "manual" | "event"
  const [mode, setMode]               = useState("manual");
  const [pickedEventId, setPickedEventId] = useState("");

  const isSet       = kickoffOffset !== null;
  const autoSynced  = scanStatus === "done" && clockMapSize >= 10;
  const [showManual, setShowManual] = useState(false);

  // Build presets from actual StatsBomb Kick Off events
  const presets = useMemo(() => {
    const kickoffs = events.filter((e) => e.type === "Kick Off");
    if (!kickoffs.length) return FALLBACK_PRESETS;
    return kickoffs.map((e) => ({
      label:  `${PERIOD_LABEL[e.period] ?? `Period ${e.period}`} kickoff (${e.minute}')`,
      minute: e.minute,
      second: e.second ?? 0,
    }));
  }, [events]);

  // Events suitable for calibration: named player events with a clear moment
  const calEvents = useMemo(() => {
    const GOOD_TYPES = new Set(["Shot", "Dribble", "Goal Keeper", "Foul Committed", "Foul Won", "Kick Off"]);
    return events.filter((e) => e.player && GOOD_TYPES.has(e.type));
  }, [events]);

  const pickedEvent = useMemo(
    () => calEvents.find((e) => e.id === pickedEventId) ?? null,
    [calEvents, pickedEventId]
  );

  const handleSet = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    const videoTime = videoRef.current.currentTime;

    let matchSeconds;
    if (mode === "event" && pickedEvent) {
      matchSeconds = pickedEvent.match_seconds;
    } else {
      matchSeconds = matchMinute * 60 + matchSecond;
    }

    const offset = videoTime - matchSeconds;
    onCalibrated(offset);
    setConfirming(true);
    setTimeout(() => setConfirming(false), 1800);
  }, [videoRef, mode, pickedEvent, matchMinute, matchSecond, onCalibrated]);

  const handleReset = useCallback(() => onCalibrated(null), [onCalibrated]);

  const applyPreset = useCallback((preset) => {
    setMatchMinute(preset.minute);
    setMatchSecond(preset.second);
    setMode("manual");
  }, []);

  const pinnedMatchSeconds = isSet ? currentTime - kickoffOffset : null;

  // ── Scanning state ────────────────────────────────────────────────────────
  if (scanStatus === "running") {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.stepLabel}>Step 2</span>
          <h3 className={styles.title}>Sync Video to Match Clock</h3>
        </div>
        <div className={styles.scanningRow}>
          <span className={styles.spinner} />
          <span className={styles.scanningText}>
            Scanning broadcast clock… this takes ~30–60 seconds
          </span>
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
          <span className={styles.badge}>&#10003; Auto-synced</span>
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

  return (
    <div className={`${styles.panel} ${isSet ? styles.done : ""}`}>
      <div className={styles.header}>
        <span className={styles.stepLabel}>Step 2</span>
        <h3 className={styles.title}>Sync Video to Match Clock</h3>
        {isSet && <span className={styles.badge}>&#10003; Synced</span>}
      </div>
      {scanStatus === "failed" && scanError && (
        <p className={styles.tip}>{scanError}</p>
      )}

      {!isSet ? (
        <>
          <p className={styles.instructions}>
            Scrub to a frame you can identify, select that moment below,
            then click <strong>Set Reference</strong>.
          </p>

          {/* Mode tabs */}
          <div className={styles.modeTabs}>
            <button
              className={`${styles.modeTab} ${mode === "manual" ? styles.modeTabActive : ""}`}
              onClick={() => setMode("manual")}
            >
              Enter time manually
            </button>
            {calEvents.length > 0 && (
              <button
                className={`${styles.modeTab} ${mode === "event" ? styles.modeTabActive : ""}`}
                onClick={() => setMode("event")}
              >
                Pick a match event
              </button>
            )}
          </div>

          {mode === "manual" ? (
            <>
              {/* Presets built from actual StatsBomb kickoff events */}
              <div className={styles.presets}>
                {presets.map((p) => (
                  <button
                    key={p.label}
                    className={styles.preset}
                    onClick={() => applyPreset(p)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <p className={styles.tip}>
                ⚠ Use <strong>StatsBomb match time</strong>, not the broadcast clock.
                If the first half had added time, StatsBomb's 2nd half kickoff may be at
                minute 48–50, not 45. Use the presets above (auto-filled from your match data)
                or pick an event below.
              </p>

              <div className={styles.matchTimeRow}>
                <span className={styles.matchTimeLabel}>Match time at this frame:</span>
                <div className={styles.matchTimeInputs}>
                  <input
                    type="number"
                    className={styles.timeInput}
                    min="0" max="130" placeholder="45"
                    value={matchMinute}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 0;
                      setMatchMinute(Math.min(130, Math.max(0, v)));
                    }}
                  />
                  <span className={styles.timeSep}>:</span>
                  <input
                    type="number"
                    className={styles.timeInput}
                    min="0" max="59" placeholder="00"
                    value={matchSecond}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 0;
                      setMatchSecond(Math.min(59, Math.max(0, v)));
                    }}
                  />
                  <span className={styles.timeSepLabel}>MM : SS</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className={styles.tip}>
                Find a specific event in your video (a shot, dribble, etc.),
                pause on that exact frame, then select the same event here.
                This avoids broadcast-clock vs StatsBomb timing differences.
              </p>
              <select
                className={styles.eventPicker}
                value={pickedEventId}
                onChange={(e) => setPickedEventId(e.target.value)}
              >
                <option value="">— pick a recognisable event —</option>
                {calEvents.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.minute}&#39;{String(e.second ?? 0).padStart(2, "0")}″ · {e.type} · {e.player}
                  </option>
                ))}
              </select>
              {pickedEvent && (
                <p className={styles.tip} style={{ marginTop: "0.3rem" }}>
                  Will sync video frame to StatsBomb time{" "}
                  <strong>
                    {pickedEvent.minute}:{String(pickedEvent.second ?? 0).padStart(2, "0")}
                  </strong>{" "}
                  ({pickedEvent.match_seconds}s into match).
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <p className={styles.instructions}>
          Synced — video frame{" "}
          <strong>{formatVideoTime(kickoffOffset + pinnedMatchSeconds)}</strong>{" "}
          corresponds to match time{" "}
          <strong>{formatMatchTime(Math.floor(pinnedMatchSeconds / 60), Math.round(pinnedMatchSeconds % 60))}</strong>.{" "}
          <button className={styles.remarkLink} onClick={handleReset}>
            Re-sync
          </button>
        </p>
      )}

      {/* Step controls */}
      <div className={styles.controls}>
        <div className={styles.group}>
          <button className={styles.stepBtn} onClick={() => stepVideo(videoRef, -5)}  disabled={isSet}>−5s</button>
          <button className={styles.stepBtn} onClick={() => stepVideo(videoRef, -1)}  disabled={isSet}>−1s</button>
        </div>
        <div className={styles.group}>
          <button className={`${styles.stepBtn} ${styles.frameBtn}`} onClick={() => stepVideo(videoRef, -FRAME_S)} disabled={isSet}>◀ 1f</button>
          <button className={`${styles.stepBtn} ${styles.frameBtn}`} onClick={() => stepVideo(videoRef,  FRAME_S)} disabled={isSet}>1f ▶</button>
        </div>
        <div className={styles.group}>
          <button className={styles.stepBtn} onClick={() => stepVideo(videoRef,  1)}  disabled={isSet}>+1s</button>
          <button className={styles.stepBtn} onClick={() => stepVideo(videoRef,  5)}  disabled={isSet}>+5s</button>
        </div>

        <div className={styles.clock}>{formatVideoTime(currentTime)}</div>

        {!isSet ? (
          <button
            className={styles.markBtn}
            onClick={handleSet}
            disabled={mode === "event" && !pickedEvent}
          >
            Set Reference
          </button>
        ) : confirming ? (
          <span className={styles.confirmed}>&#10003; Synced!</span>
        ) : (
          <button className={styles.remarkBtn} onClick={handleReset}>Re-sync</button>
        )}
      </div>

      {/* Offset summary */}
      {isSet && (
        <div className={styles.offsetBar}>
          <span className={styles.offsetLabel}>Offset</span>
          <span className={styles.offsetValue}>{formatOffset(kickoffOffset)}</span>
          <span className={styles.offsetFormula}>
            video time = match time {formatOffset(kickoffOffset)}
          </span>
        </div>
      )}
    </div>
  );
}
