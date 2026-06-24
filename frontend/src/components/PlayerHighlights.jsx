import React, { useState, useMemo, useCallback } from "react";
import { generateClips, API_URL } from "../services/api";
import styles from "./PlayerHighlights.module.css";

const CLIP_EVENT_TYPES = new Set([
  "Shot", "Dribble", "Foul Committed", "Foul Won",
  "Ball Recovery", "Clearance",
  "Goal Keeper", "Interception", "Duel", "Block",
]);

const TYPE_COLORS = {
  Shot: "#e74c3c",
  Dribble: "#9b59b6",
  Pass: "#3498db",
  Carry: "#1abc9c",
  "Foul Committed": "#c0392b",
  "Foul Won": "#e67e22",
  "Ball Recovery": "#2ecc71",
  default: "#555",
};

function dotColor(type) {
  return TYPE_COLORS[type] ?? TYPE_COLORS.default;
}

function fmtClock(minute, second) {
  return `${minute ?? 0}'${String(second ?? 0).padStart(2, "0")}"`;
}

function fmtVideoTime(seconds) {
  if (seconds == null || isNaN(seconds)) return null;
  const sign = seconds < 0 ? "-" : "";
  const abs  = Math.abs(seconds);
  const m    = Math.floor(abs / 60);
  const s    = Math.floor(abs % 60);
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

export default function PlayerHighlights({
  events,
  toVideoTime,
  clockMap,
  halfOffsets,
  videoFilename,
  duration,
  isSynced,
}) {
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [typeFilter, setTypeFilter]         = useState("all");
  const [selected, setSelected]             = useState(new Set());
  const [paddingBefore, setPaddingBefore]   = useState(5);
  const [paddingAfter, setPaddingAfter]     = useState(10);
  const [generating, setGenerating]         = useState(false);
  const [progress, setProgress]             = useState(null); // "3 / 12 clips"
  const [clipId, setClipId]                 = useState(null);
  const [error, setError]                   = useState(null);

  // ── Derived data ──────────────────────────────────────────────────────────

  // All players sorted alphabetically, with event counts
  const players = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      if (!e.player) continue;
      map.set(e.player, (map.get(e.player) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [events]);

  // Event types available for the selected player
  const playerTypes = useMemo(() => {
    if (!selectedPlayer) return [];
    const s = new Set(
      events
        .filter((e) => e.player === selectedPlayer)
        .map((e) => e.type)
        .filter(Boolean)
    );
    return ["all", ...Array.from(s).sort()];
  }, [events, selectedPlayer]);

  // Filtered events for the selected player
  const playerEvents = useMemo(() => {
    if (!selectedPlayer) return [];
    return events.filter(
      (e) =>
        e.player === selectedPlayer &&
        (typeFilter === "all" || e.type === typeFilter)
    );
  }, [events, selectedPlayer, typeFilter]);

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggleEvent = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(playerEvents.map((e) => e.id)));
  }, [playerEvents]);

  const deselectAll = useCallback(() => setSelected(new Set()), []);

  // When player changes, auto-select their shots/dribbles/key events
  const handlePlayerChange = useCallback((name) => {
    setSelectedPlayer(name);
    setTypeFilter("all");
    setClipId(null);
    setError(null);
    // Auto-select visually interesting events
    const autoSelected = new Set(
      events
        .filter((e) => e.player === name && CLIP_EVENT_TYPES.has(e.type))
        .map((e) => e.id)
    );
    setSelected(autoSelected);
  }, [events]);

  // ── Generate ──────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!selected.size || !videoFilename) return;
    setGenerating(true);
    setError(null);
    setClipId(null);
    setProgress(`0 / ${selected.size} clips`);

    const chosenEvents = events.filter((e) => selected.has(e.id));

    try {
      const { data } = await generateClips({
        filename:       videoFilename,
        events:         chosenEvents,
        all_events:     events,
        clock_map:      clockMap ?? undefined,
        half_offsets:   halfOffsets ?? undefined,
        padding_before: paddingBefore,
        padding_after:  paddingAfter,
        video_duration: duration || undefined,
      });
      setClipId(data.clip_id);
      setProgress(`${data.clip_count} clips compiled`);
    } catch (err) {
      setError(
        err.response?.data?.error ?? "Generation failed — is ffmpeg installed?"
      );
    } finally {
      setGenerating(false);
    }
  }, [selected, events, videoFilename, clockMap, halfOffsets, paddingBefore, paddingAfter, duration]);

  const downloadUrl = clipId ? `${API_URL}/api/clips/${clipId}` : null;

  // ── Render ────────────────────────────────────────────────────────────────

  if (!events.length) return null;

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Player Highlights</h2>

      {/* ── Player picker ──────────────────────────────────────────────── */}
      <div className={styles.field}>
        <label className={styles.label}>Player</label>
        <select
          className={styles.select}
          value={selectedPlayer}
          onChange={(e) => handlePlayerChange(e.target.value)}
        >
          <option value="">— select a player —</option>
          {players.map(({ name, count }) => (
            <option key={name} value={name}>
              {name} ({count} events)
            </option>
          ))}
        </select>
      </div>

      {selectedPlayer && (
        <>
          {/* ── Event type filter ───────────────────────────────────────── */}
          <div className={styles.field}>
            <label className={styles.label}>Event type</label>
            <div className={styles.chips}>
              {playerTypes.map((t) => (
                <button
                  key={t}
                  className={`${styles.chip} ${typeFilter === t ? styles.chipActive : ""}`}
                  onClick={() => setTypeFilter(t)}
                >
                  {t === "all" ? "All types" : t}
                </button>
              ))}
            </div>
          </div>

          {/* ── Selection controls ──────────────────────────────────────── */}
          <div className={styles.selectionBar}>
            <span className={styles.selectionCount}>
              {selected.size} selected
            </span>
            <button className={styles.textBtn} onClick={selectAll}>Select all</button>
            <button className={styles.textBtn} onClick={deselectAll}>Deselect all</button>
          </div>

          {/* ── Event list ──────────────────────────────────────────────── */}
          <ul className={styles.eventList}>
            {playerEvents.map((e) => {
              const isChecked = selected.has(e.id);
              const vt        = toVideoTime(e.match_seconds ?? 0, e.period ?? 1);
              const outOfRange = vt !== null && (vt < 0 || (duration && vt > duration));
              const period1   = e.period === 1;
              return (
                <li
                  key={e.id}
                  className={`${styles.eventRow} ${isChecked ? styles.eventRowChecked : ""} ${outOfRange ? styles.eventRowWarn : ""}`}
                  onClick={() => toggleEvent(e.id)}
                >
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={isChecked}
                    onChange={() => toggleEvent(e.id)}
                    onClick={(ev) => ev.stopPropagation()}
                  />
                  <span
                    className={styles.dot}
                    style={{ backgroundColor: dotColor(e.type) }}
                  />
                  <span className={styles.clock}>{fmtClock(e.minute, e.second)}</span>
                  <div className={styles.eventDetails}>
                    <span className={styles.typeName}>{e.type}</span>
                    {period1 && (
                      <span className={styles.badgeP1} title="First half event">1H</span>
                    )}
                    {e.shot?.outcome && (
                      <span className={`${styles.badge} ${e.shot.outcome === "Goal" ? styles.badgeGoal : styles.badgeMiss}`}>
                        {e.shot.outcome}
                        {e.shot.statsbomb_xg != null && ` · xG ${e.shot.statsbomb_xg.toFixed(2)}`}
                      </span>
                    )}
                    {e.pass?.outcome && (
                      <span className={styles.badgeMiss}>{e.pass.outcome}</span>
                    )}
                  </div>
                  {isSynced && (
                    <span className={outOfRange ? styles.videoTimeWarn : styles.videoTime}
                      title={outOfRange ? "This event falls outside your video's duration" : undefined}>
                      {outOfRange ? "⚠ " : ""}{fmtVideoTime(vt)}
                    </span>
                  )}
                </li>
              );
            })}
            {playerEvents.length === 0 && (
              <li className={styles.empty}>No events for this filter.</li>
            )}
          </ul>

          {/* ── Clip padding ────────────────────────────────────────────── */}
          <div className={styles.paddingRow}>
            <label className={styles.label}>Clip padding</label>
            <div className={styles.paddingControls}>
              <span className={styles.paddingLabel}>before</span>
              <input
                type="number" min="0" max="30" step="1"
                className={styles.paddingInput}
                value={paddingBefore}
                onChange={(e) => setPaddingBefore(Number(e.target.value))}
              />
              <span className={styles.paddingLabel}>s</span>
              <span className={styles.paddingLabel} style={{ marginLeft: "0.75rem" }}>after</span>
              <input
                type="number" min="1" max="60" step="1"
                className={styles.paddingInput}
                value={paddingAfter}
                onChange={(e) => setPaddingAfter(Number(e.target.value))}
              />
              <span className={styles.paddingLabel}>s</span>
            </div>
          </div>

          {/* ── Generate button ─────────────────────────────────────────── */}
          {error && <p className={styles.error}>{error}</p>}

          {!clipId ? (
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={generating || !selected.size || !videoFilename || !isSynced}
              title={
                !isSynced
                  ? "Waiting for clock sync"
                  : !videoFilename
                  ? "No video uploaded"
                  : ""
              }
            >
              {generating ? (
                <>
                  <span className={styles.spinner} />
                  {progress ?? "Generating…"}
                </>
              ) : (
                `Generate ${selected.size} clip${selected.size !== 1 ? "s" : ""}`
              )}
            </button>
          ) : (
            <div className={styles.downloadRow}>
              <span className={styles.successMsg}>✓ {progress}</span>
              <a
                className={styles.downloadBtn}
                href={downloadUrl}
                download="highlights.mp4"
              >
                Download MP4
              </a>
              <button
                className={styles.textBtn}
                onClick={() => { setClipId(null); setProgress(null); }}
              >
                Generate again
              </button>
            </div>
          )}

          {!isSynced && (
            <p className={styles.hint}>Waiting for clock sync to enable clip generation.</p>
          )}
        </>
      )}
    </div>
  );
}
