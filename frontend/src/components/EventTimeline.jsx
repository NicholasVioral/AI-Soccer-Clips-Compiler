import React, { useMemo } from "react";
import styles from "./EventTimeline.module.css";

export const TYPE_COLORS = {
  Shot: "#e74c3c",
  Goal: "#f39c12",
  Pass: "#3498db",
  Dribble: "#9b59b6",
  "Ball Receipt*": "#2ecc71",
  Carry: "#1abc9c",
  Pressure: "#e67e22",
  Foul: "#c0392b",
  default: "#444",
};

function colorFor(type) {
  return TYPE_COLORS[type] ?? TYPE_COLORS.default;
}

export default function EventTimeline({
  events,
  duration,
  currentTime,
  toVideoTime,
  onSeek,
}) {
  // Position an event on the scrubbar (0–100%) relative to full video duration
  const toPercent = (e) => {
    if (!duration) return 0;
    const vt = toVideoTime(e.match_seconds ?? 0, e.period ?? 1);
    if (vt == null) return -1;
    return Math.min(100, Math.max(0, (vt / duration) * 100));
  };

  // Current playhead position
  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Half-time marker: first event in period 2 gives us the ~45-min video timestamp
  const halfTimePercent = useMemo(() => {
    if (!duration) return null;
    const p2 = events.find((e) => e.period === 2);
    if (!p2) return null;
    const vt = toVideoTime(p2.match_seconds ?? 0);
    if (vt == null) return null;
    return (vt / duration) * 100;
  }, [events, toVideoTime, duration]);

  const handleTrackClick = (ev) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const pct = (ev.clientX - rect.left) / rect.width;
    onSeek(pct * duration);
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.track} onClick={handleTrackClick}>
        {/* Period divider (half-time) */}
        {halfTimePercent != null && (
          <div
            className={styles.periodDivider}
            style={{ left: `${halfTimePercent}%` }}
            title="Half time"
          />
        )}

        {/* Playhead */}
        <div className={styles.playhead} style={{ left: `${playheadPercent}%` }} />

        {/* Event markers */}
        {events.map((e, i) => {
          const vt = toVideoTime(e.match_seconds ?? 0, e.period ?? 1);
          return (
            <div
              key={e.id ?? i}
              className={styles.marker}
              style={{
                left: `${toPercent(e)}%`,
                backgroundColor: colorFor(e.type),
              }}
              title={`${e.type}${e.player ? " — " + e.player : ""} (${e.minute ?? 0}'${String(e.second ?? 0).padStart(2, "0")} → ${formatVT(vt)})`}
              onClick={(ev) => {
                ev.stopPropagation();
                onSeek(vt);
              }}
            />
          );
        })}
      </div>

      {/* Period labels */}
      <div className={styles.periodLabels}>
        <span>1st half</span>
        {halfTimePercent != null && (
          <span style={{ marginLeft: `${halfTimePercent}%`, transform: "translateX(-50%)" }}>
            2nd half
          </span>
        )}
      </div>

      {/* Legend */}
      <div className={styles.legend}>
        {Object.entries(TYPE_COLORS)
          .filter(([k]) => k !== "default")
          .map(([type, color]) => (
            <span key={type} className={styles.legendItem}>
              <span className={styles.dot} style={{ backgroundColor: color }} />
              {type}
            </span>
          ))}
      </div>
    </div>
  );
}

function formatVT(seconds) {
  if (seconds == null || isNaN(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
