import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { generateClips, API_URL } from "../services/api";
import { loadOverrides, saveOverrides, parseVideoTime } from "../services/clipOverrides";
import ExternalClips from "./ExternalClips";
import styles from "./PlayerHighlights.module.css";

// Clips begin a few seconds before the event; the end is determined by the
// backend's possession analysis (subsequent events), so these are just the
// start offset and a minimum-duration floor — no longer user-configurable.
const PADDING_BEFORE = 5;
const PADDING_AFTER  = 10;

// Seconds of run-up to include when seeking to an event, so playback starts
// before the action rather than landing mid-move. Used by the ▶ jump button
// and autoplay review.
const SEEK_LEAD_IN = 4;

// Autoplay review: how much of the video to play around each event before
// advancing to the next one.
const PREVIEW_BEFORE = SEEK_LEAD_IN;  // start this many seconds before the event
const PREVIEW_AFTER  = 5;             // advance this many seconds after the event

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

// Editable video-time for one event. Shows the automatic time, but lets the
// user override it (type a M:SS time, or capture the current playhead) when the
// sync is off for that event. ▶ jumps there; ↺ resets to automatic.
function TimeCell({ eventId, computedVt, override, outOfRange, currentTime, onSetOverride, onSeek }) {
  const hasOverride = override != null;
  const effective   = hasOverride ? override : computedVt;
  const [draft, setDraft]     = useState(effective != null ? fmtVideoTime(effective) : "");
  const [editing, setEditing] = useState(false);

  // Resync the field when the value changes from outside (reset, set-to-
  // playhead, sync change) — but never while the user is mid-edit.
  useEffect(() => {
    if (!editing) setDraft(effective != null ? fmtVideoTime(effective) : "");
  }, [effective, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = parseVideoTime(draft);
    if (parsed == null) {
      setDraft(effective != null ? fmtVideoTime(effective) : "");
      return;
    }
    // Matching the automatic time means "no override".
    if (computedVt != null && Math.abs(parsed - computedVt) < 0.5) {
      onSetOverride(eventId, null);
    } else {
      onSetOverride(eventId, parsed);
    }
  };

  return (
    <div className={styles.timeCell} onClick={(ev) => ev.stopPropagation()}>
      <input
        className={`${styles.timeInput} ${hasOverride ? styles.timeInputOverride : ""} ${outOfRange ? styles.timeInputWarn : ""}`}
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.currentTarget.blur();
          if (ev.key === "Escape") {
            setDraft(effective != null ? fmtVideoTime(effective) : "");
            setEditing(false);
            ev.currentTarget.blur();
          }
        }}
        title={
          hasOverride
            ? "Manually set video time — ↺ resets to automatic"
            : outOfRange
            ? "This time falls outside the video's duration"
            : "Video time — edit, or use ⌖ to pin the current playhead"
        }
        spellCheck={false}
      />
      {currentTime != null && (
        <button type="button" className={styles.timeBtn}
          title="Set to current video position"
          onClick={() => onSetOverride(eventId, currentTime)}>⌖</button>
      )}
      {onSeek && effective != null && (
        <button type="button" className={styles.timeBtn}
          title="Play from a few seconds before this event"
          onClick={() => onSeek(Math.max(0, effective - SEEK_LEAD_IN))}>▶</button>
      )}
      {hasOverride && (
        <button type="button" className={styles.timeBtn}
          title="Reset to automatic time"
          onClick={() => onSetOverride(eventId, null)}>↺</button>
      )}
    </div>
  );
}

export default function PlayerHighlights({
  events,
  toVideoTime,
  clockMap,
  halfOffsets,
  videoFilename,
  duration,
  isSynced,
  currentTime,
  onSeek,
}) {
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [typeFilter, setTypeFilter]         = useState("all");
  const [selected, setSelected]             = useState(new Set());
  const [generating, setGenerating]         = useState(false);
  const [progress, setProgress]             = useState(null); // "3 / 12 clips"
  const [clipId, setClipId]                 = useState(null);
  const [error, setError]                   = useState(null);

  // External clips (e.g. a YouTube celebration) to splice into the reel, in a
  // manually-ordered list, plus where they go relative to the event clips.
  const [externalClips, setExternalClips]     = useState([]);
  const [externalPlacement, setExternalPlacement] = useState("end");

  // Per-event manual video-time overrides (persisted per video). When the
  // automatic sync is off for a specific event, the user pins its correct video
  // time here and the whole clip is shifted to land there.
  const [overrides, setOverrides] = useState(() => loadOverrides(videoFilename));

  useEffect(() => {
    setOverrides(loadOverrides(videoFilename));
  }, [videoFilename]);

  const setOverride = useCallback((eventId, seconds) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (seconds == null) delete next[eventId];
      else next[eventId] = seconds;
      saveOverrides(videoFilename, next);
      return next;
    });
  }, [videoFilename]);

  // ── Autoplay review ────────────────────────────────────────────────────────
  // Play through the visible events one by one so you can eyeball each and mark
  // the good ones. previewIndex is the index into playerEvents currently
  // playing, or null when not reviewing.
  const [previewIndex, setPreviewIndex] = useState(null);
  const previewSeekRef = useRef({ awaiting: false, start: 0 });

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

  // "Select all" / "Deselect all" act on the currently visible events (the
  // active type filter) and merge into the existing selection, so selecting
  // all in one category doesn't wipe out choices made in another.
  const selectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of playerEvents) next.add(e.id);
      return next;
    });
  }, [playerEvents]);

  const deselectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of playerEvents) next.delete(e.id);
      return next;
    });
  }, [playerEvents]);

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
    setPreviewIndex(null);
  }, [events]);

  // Effective video time for an event (manual override wins over auto sync).
  const videoTimeOf = useCallback((e) => {
    const ov = overrides[e.id];
    return ov != null ? ov : toVideoTime(e.match_seconds ?? 0, e.period ?? 1);
  }, [overrides, toVideoTime]);

  const startPreview = useCallback(() => {
    if (!playerEvents.length) return;
    setClipId(null);
    setPreviewIndex(0);
  }, [playerEvents]);

  const stopPreview  = useCallback(() => setPreviewIndex(null), []);
  const previewPrev  = useCallback(() => setPreviewIndex((i) => (i == null ? null : Math.max(0, i - 1))), []);
  const previewNext  = useCallback(
    () => setPreviewIndex((i) => (i != null && i + 1 < playerEvents.length ? i + 1 : null)),
    [playerEvents]
  );

  const markCurrentGood = useCallback(() => {
    const e = previewIndex != null ? playerEvents[previewIndex] : null;
    if (e) setSelected((prev) => new Set(prev).add(e.id));
  }, [previewIndex, playerEvents]);

  // Seek to the current preview event's lead-in whenever the index changes.
  useEffect(() => {
    if (previewIndex == null) return;
    const e = playerEvents[previewIndex];
    if (!e) { setPreviewIndex(null); return; }
    const vt = videoTimeOf(e);
    if (vt == null) { setPreviewIndex(null); return; }
    const start = Math.max(0, vt - PREVIEW_BEFORE);
    previewSeekRef.current = { awaiting: true, start };
    onSeek?.(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewIndex]);

  // Advance to the next event once the current one's window has played out.
  useEffect(() => {
    if (previewIndex == null || currentTime == null) return;
    const e = playerEvents[previewIndex];
    if (!e) return;
    const vt = videoTimeOf(e);
    if (vt == null) return;
    const st = previewSeekRef.current;
    if (st.awaiting) {
      // Don't advance until the seek has actually landed near the start.
      if (currentTime <= st.start + 1.5) st.awaiting = false;
      return;
    }
    if (currentTime >= vt + PREVIEW_AFTER) {
      setPreviewIndex((i) => (i != null && i + 1 < playerEvents.length ? i + 1 : null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, previewIndex]);

  // ── Generate ──────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    const totalCount = selected.size + externalClips.length;
    if (!totalCount || !videoFilename) return;
    setGenerating(true);
    setError(null);
    setClipId(null);
    setProgress(`0 / ${totalCount} clips`);

    // Attach any manual video-time override so the backend shifts that clip.
    const chosenEvents = events
      .filter((e) => selected.has(e.id))
      .map((e) =>
        overrides[e.id] != null
          ? { ...e, video_time_override: overrides[e.id] }
          : e
      );

    try {
      const { data } = await generateClips({
        filename:           videoFilename,
        events:             chosenEvents,
        all_events:         events,
        clock_map:          clockMap ?? undefined,
        half_offsets:       halfOffsets ?? undefined,
        padding_before:     PADDING_BEFORE,
        padding_after:      PADDING_AFTER,
        video_duration:     duration || undefined,
        external_clips:     externalClips.map((c) => c.id),
        external_placement: externalPlacement,
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
  }, [selected, events, overrides, videoFilename, clockMap, halfOffsets,
      duration, externalClips, externalPlacement]);

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
            <button
              className={styles.textBtn}
              onClick={startPreview}
              disabled={!playerEvents.length || !isSynced}
              title={!isSynced ? "Waiting for clock sync" : "Play through each event to review them"}
            >
              ▶ Autoplay ({playerEvents.length})
            </button>
          </div>

          {/* ── Autoplay review bar ─────────────────────────────────────── */}
          {previewIndex != null && playerEvents[previewIndex] && (
            <div className={styles.previewBar}>
              <span className={styles.previewInfo}>
                Reviewing {previewIndex + 1}/{playerEvents.length}
                {" · "}
                {fmtClock(playerEvents[previewIndex].minute, playerEvents[previewIndex].second)}
              </span>
              <button className={styles.previewBtn} onClick={previewPrev} title="Previous">⏮</button>
              <button className={styles.previewBtn} onClick={previewNext} title="Next">⏭</button>
              <button
                className={`${styles.previewBtn} ${selected.has(playerEvents[previewIndex].id) ? styles.previewGoodOn : styles.previewGood}`}
                onClick={markCurrentGood}
                title="Mark this one good (adds to selection)"
              >
                {selected.has(playerEvents[previewIndex].id) ? "✓ Selected" : "✓ Good"}
              </button>
              <button className={styles.previewBtn} onClick={stopPreview} title="Stop autoplay">✕</button>
            </div>
          )}

          {/* ── Event list ──────────────────────────────────────────────── */}
          <ul className={styles.eventList}>
            {playerEvents.map((e, idx) => {
              const isChecked = selected.has(e.id);
              const isPreviewing = idx === previewIndex;
              const computedVt = toVideoTime(e.match_seconds ?? 0, e.period ?? 1);
              const override   = overrides[e.id];
              const effectiveVt = override != null ? override : computedVt;
              const outOfRange = effectiveVt != null && (effectiveVt < 0 || (duration && effectiveVt > duration));
              const period1   = e.period === 1;
              return (
                <li
                  key={e.id}
                  className={`${styles.eventRow} ${isChecked ? styles.eventRowChecked : ""} ${outOfRange ? styles.eventRowWarn : ""} ${isPreviewing ? styles.eventRowPreviewing : ""}`}
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
                    <TimeCell
                      eventId={e.id}
                      computedVt={computedVt}
                      override={override}
                      outOfRange={outOfRange}
                      currentTime={currentTime}
                      onSetOverride={setOverride}
                      onSeek={onSeek}
                    />
                  )}
                </li>
              );
            })}
            {playerEvents.length === 0 && (
              <li className={styles.empty}>No events for this filter.</li>
            )}
          </ul>

          {/* ── External clips (YouTube celebrations etc.) ──────────────── */}
          <ExternalClips
            clips={externalClips}
            setClips={setExternalClips}
            placement={externalPlacement}
            setPlacement={setExternalPlacement}
          />

          {/* ── Generate button ─────────────────────────────────────────── */}
          {error && <p className={styles.error}>{error}</p>}

          {(() => {
            const totalCount = selected.size + externalClips.length;
            // Event clips need clock sync to be placed; external clips don't.
            // Allow generation when there are external clips even if unsynced,
            // or when events are selected and the video is synced.
            const eventsBlocked = selected.size > 0 && !isSynced;
            const canGenerate =
              !!videoFilename && totalCount > 0 &&
              (externalClips.length > 0 ? true : !eventsBlocked);
            return !clipId ? (
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={generating || !canGenerate}
              title={
                !videoFilename
                  ? "No video uploaded"
                  : eventsBlocked && !externalClips.length
                  ? "Waiting for clock sync"
                  : ""
              }
            >
              {generating ? (
                <>
                  <span className={styles.spinner} />
                  {progress ?? "Generating…"}
                </>
              ) : (
                `Generate ${totalCount} clip${totalCount !== 1 ? "s" : ""}`
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
          );
          })()}

          {!isSynced && selected.size > 0 && !externalClips.length && (
            <p className={styles.hint}>Waiting for clock sync to enable clip generation.</p>
          )}
        </>
      )}
    </div>
  );
}
