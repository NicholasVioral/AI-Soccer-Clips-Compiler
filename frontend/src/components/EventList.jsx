import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import styles from "./EventList.module.css";

// ── Constants ────────────────────────────────────────────────────────────────

const PERIOD_LABELS = {
  1: "1st Half",
  2: "2nd Half",
  3: "Extra Time — 1st",
  4: "Extra Time — 2nd",
  5: "Penalties",
};

// Matches the dot palette used in EventTimeline
const TYPE_COLORS = {
  Shot: "#e74c3c",
  Goal: "#f39c12",
  Pass: "#3498db",
  Dribble: "#9b59b6",
  "Ball Receipt*": "#2ecc71",
  Carry: "#1abc9c",
  Pressure: "#e67e22",
  Foul: "#c0392b",
};

const IMPORTANT_TYPES = new Set(["Shot", "Goal", "Foul", "Dribble", "Pressure"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function dotColor(type) {
  return TYPE_COLORS[type] ?? "#555";
}

/** Match clock label: 45'32" */
function fmtClock(minute, second) {
  return `${minute ?? 0}'${String(second ?? 0).padStart(2, "0")}"`;
}

/** Video position label: 1:23:45 or 23:45 */
function fmtVideo(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * EventList — scrollable event timeline panel.
 *
 * kickoffOffset may be null when the user has not yet marked kickoff.
 * In that state the panel is still visible and browseable; clicking an
 * event shows an inline nudge instead of seeking.
 */
export default function EventList({ events, currentTime, toVideoTime, isSynced, onSeek }) {
  const calibrated = isSynced;

  const [quickFilter, setQuickFilter] = useState("all"); // "all" | "important"
  const [typeFilter, setTypeFilter]   = useState("all");
  const [search, setSearch]           = useState("");
  const [nudgeId, setNudgeId]         = useState(null);  // id of row that triggered the "mark kickoff" nudge

  // Derive unique type list from the full event set (not filtered, so the
  // select always shows every type regardless of the text search).
  const allTypes = useMemo(() => {
    const s = new Set(events.map((e) => e.type).filter(Boolean));
    return ["all", ...Array.from(s).sort()];
  }, [events]);

  // Apply filters: quick filter → type dropdown → text search
  const filtered = useMemo(() => {
    let list = events;

    if (quickFilter === "important")
      list = list.filter((e) => IMPORTANT_TYPES.has(e.type));

    if (typeFilter !== "all")
      list = list.filter((e) => e.type === typeFilter);

    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (e) =>
          (e.player ?? "").toLowerCase().includes(q) ||
          (e.type  ?? "").toLowerCase().includes(q) ||
          (e.team  ?? "").toLowerCase().includes(q)
      );

    return list;
  }, [events, quickFilter, typeFilter, search]);

  // Build a display list that injects period-separator rows between periods
  const listItems = useMemo(() => {
    const items = [];
    let lastPeriod = null;
    for (const e of filtered) {
      if (e.period !== lastPeriod) {
        items.push({
          kind: "separator",
          period: e.period,
          label: PERIOD_LABELS[e.period] ?? `Period ${e.period}`,
        });
        lastPeriod = e.period;
      }
      items.push({ kind: "event", event: e });
    }
    return items;
  }, [filtered]);

  // Find the event closest to currentTime (only when calibrated)
  const activeEventId = useMemo(() => {
    if (!calibrated) return null;
    let bestId = null;
    let bestDiff = Infinity;
    for (const e of filtered) {
      const vt = toVideoTime(e.match_seconds ?? 0, e.period ?? 1);
      if (vt == null) continue;
      const diff = Math.abs(vt - currentTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestId = e.id;
      }
    }
    return bestId;
  }, [filtered, currentTime, toVideoTime, calibrated]);

  // Ref map: eventId → DOM node, so we can keep the active row in view
  const rowRefs = useRef({});
  const setRowRef = useCallback((id, node) => {
    if (node) rowRefs.current[id] = node;
    else delete rowRefs.current[id];
  }, []);

  // Scroll container for the list. We scroll ONLY this element to follow the
  // active event — never element.scrollIntoView(), which walks up and scrolls
  // the whole page (yanking the video out of view during playback).
  const listRef = useRef(null);

  useEffect(() => {
    const container = listRef.current;
    const row = activeEventId ? rowRefs.current[activeEventId] : null;
    if (!container || !row) return;

    const cRect = container.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();

    // Only adjust the container's own scroll, and only when the row is actually
    // outside the visible area, so a visible active row causes no movement.
    if (rRect.top < cRect.top) {
      container.scrollTop -= cRect.top - rRect.top;
    } else if (rRect.bottom > cRect.bottom) {
      container.scrollTop += rRect.bottom - cRect.bottom;
    }
  }, [activeEventId]);

  // Handle row click
  const handleEventClick = useCallback(
    (e) => {
      if (!calibrated) {
        setNudgeId(e.id);
        setTimeout(() => setNudgeId(null), 2200);
        return;
      }
      onSeek(toVideoTime(e.match_seconds ?? 0, e.period ?? 1));
    },
    [calibrated, toVideoTime, onSeek]
  );

  // Count label
  const countLabel = `${filtered.length.toLocaleString()} / ${events.length.toLocaleString()} events`;

  return (
    <div className={styles.wrapper}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <span className={styles.count}>{countLabel}</span>
        {!calibrated && (
          <span className={styles.uncalibratedBadge} title="Mark kickoff to enable seek">
            &#9678; Mark kickoff to seek
          </span>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className={styles.filters}>
        {/* Quick filter chips */}
        <div className={styles.chips}>
          <button
            className={`${styles.chip} ${quickFilter === "all" ? styles.chipActive : ""}`}
            onClick={() => setQuickFilter("all")}
          >
            All
          </button>
          <button
            className={`${styles.chip} ${quickFilter === "important" ? styles.chipActive : ""}`}
            onClick={() => setQuickFilter("important")}
          >
            Key Events
          </button>
        </div>

        {/* Type dropdown */}
        <select
          className={styles.select}
          value={typeFilter}
          onChange={(ev) => setTypeFilter(ev.target.value)}
        >
          {allTypes.map((t) => (
            <option key={t} value={t}>
              {t === "all" ? "All types" : t}
            </option>
          ))}
        </select>
      </div>

      {/* ── Search ─────────────────────────────────────────────────────── */}
      <div className={styles.searchRow}>
        <span className={styles.searchIcon}>&#128269;</span>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search player, type, or team…"
          value={search}
          onChange={(ev) => setSearch(ev.target.value)}
        />
        {search && (
          <button className={styles.clearSearch} onClick={() => setSearch("")}>
            &#10005;
          </button>
        )}
      </div>

      {/* ── Scrollable list ────────────────────────────────────────────── */}
      <ul className={styles.list} ref={listRef}>
        {listItems.length === 0 && (
          <li className={styles.empty}>No events match your filters.</li>
        )}

        {listItems.map((item, i) => {
          if (item.kind === "separator") {
            return (
              <li key={`sep-${item.period}`} className={styles.separator}>
                <span className={styles.separatorLine} />
                <span className={styles.separatorLabel}>{item.label}</span>
                <span className={styles.separatorLine} />
              </li>
            );
          }

          const e = item.event;
          const isActive = e.id === activeEventId;
          const isNudging = e.id === nudgeId;
          const vt = calibrated ? toVideoTime(e.match_seconds ?? 0, e.period ?? 1) : null;
          const videoLabel = fmtVideo(vt);

          return (
            <li
              key={e.id ?? i}
              ref={(node) => setRowRef(e.id, node)}
              className={[
                styles.item,
                isActive  ? styles.itemActive  : "",
                isNudging ? styles.itemNudge   : "",
              ].join(" ")}
              onClick={() => handleEventClick(e)}
              title={
                calibrated
                  ? `Jump to ${videoLabel} in video`
                  : "Mark kickoff first to enable seeking"
              }
            >
              {/* Coloured type dot */}
              <span
                className={styles.typeDot}
                style={{ backgroundColor: dotColor(e.type) }}
                aria-hidden="true"
              />

              {/* Match clock */}
              <span className={styles.clock}>{fmtClock(e.minute, e.second)}</span>

              {/* Event details */}
              <div className={styles.details}>
                <span className={styles.typeName}>{e.type}</span>

                {e.player && (
                  <span className={styles.player}>{e.player}</span>
                )}

                {e.team && (
                  <span className={styles.team}>{e.team}</span>
                )}

                {/* Shot outcome + xG */}
                {e.shot?.outcome && (
                  <span
                    className={`${styles.badge} ${
                      e.shot.outcome === "Goal"
                        ? styles.badgeGoal
                        : styles.badgeShot
                    }`}
                  >
                    {e.shot.outcome}
                    {e.shot.statsbomb_xg != null &&
                      ` · xG ${e.shot.statsbomb_xg.toFixed(2)}`}
                  </span>
                )}

                {/* Inline nudge when not calibrated */}
                {isNudging && (
                  <span className={styles.nudge}>
                    &#9650; Mark kickoff first
                  </span>
                )}
              </div>

              {/* Video timestamp — only shown once calibrated */}
              {videoLabel && (
                <span className={styles.videoTime}>{videoLabel}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
