import React from "react";
import { TYPE_COLORS } from "./EventTimeline";
import styles from "./HeroPreview.module.css";

/**
 * Static, non-interactive mock of the workspace: a match frame with the
 * broadcast clock locked, and the synced StatsBomb timeline beneath it.
 * Purely decorative — it renders no real data and drives nothing.
 */

// Sample match: 2010 UCL final (one of the videos in the release bundle).
const TOTAL_MIN = 95;                       // full video length the timeline spans
const pct = (minute) => (minute / TOTAL_MIN) * 100;

// Key moments keep real minute positions; the filler around them is generated
// from a fixed seed so the mock renders identically on every load.
const KEY_EVENTS = [
  { minute: 12, type: "Shot" },
  { minute: 28, type: "Shot" },
  { minute: 35, type: "Goal", big: true },
  { minute: 44, type: "Foul" },
  { minute: 52, type: "Shot" },
  { minute: 58, type: "Foul" },
  { minute: 63, type: "Dribble" },
  { minute: 70, type: "Goal", big: true },
  { minute: 81, type: "Shot" },
];

const FILLER_TYPES = ["Pass", "Pass", "Pass", "Carry", "Ball Receipt*", "Pressure", "Carry"];

const MARKERS = (() => {
  let seed = 20100522;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const filler = Array.from({ length: 84 }, () => ({
    left: 1.5 + rand() * 96,
    type: FILLER_TYPES[Math.floor(rand() * FILLER_TYPES.length)],
  }));
  const key = KEY_EVENTS.map((e) => ({ left: pct(e.minute), type: e.type, big: e.big }));
  return [...filler, ...key];
})();

const TICKS = [0, 15, 30, 45, 60, 75, 90];
const LEGEND = ["Goal", "Shot", "Pass", "Dribble", "Foul"];

const HALF_TIME = 49;        // half-time sits just past 45' of video time
const PLAYHEAD = pct(70.2);  // parked on the 70' goal

export default function HeroPreview() {
  return (
    <div className={styles.preview} aria-hidden="true">
      {/* ── Match frame ──────────────────────────────────────────────── */}
      <div className={styles.frame}>
        {/* 16:9 stage; the pitch itself keeps StatsBomb's 120 × 80 units */}
        <svg className={styles.pitch} viewBox="0 0 150 84" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="hpTurf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#161a2c" />
              <stop offset="100%" stopColor="#0d0f1c" />
            </linearGradient>
            <linearGradient id="hpPassLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#7c5cfc" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#9d7dfe" stopOpacity="0.9" />
            </linearGradient>
            <radialGradient id="hpBallGlow">
              <stop offset="0%" stopColor="#f39c12" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#f39c12" stopOpacity="0" />
            </radialGradient>
          </defs>

          <rect width="150" height="84" fill="url(#hpTurf)" />

          {/* Mown stripes */}
          <g fill="#ffffff" opacity="0.016">
            {[0, 25, 50, 75, 100, 125].map((x) => (
              <rect key={x} x={x} y="0" width="12.5" height="84" />
            ))}
          </g>

          <g transform="translate(15 2)">

          {/* Pitch markings */}
          <g stroke="rgba(255,255,255,0.23)" strokeWidth="0.4" fill="none">
            <rect x="2" y="2" width="116" height="76" />
            <line x1="60" y1="2" x2="60" y2="78" />
            <circle cx="60" cy="40" r="10" />
            <rect x="2" y="18" width="18" height="44" />
            <rect x="2" y="30" width="6" height="20" />
            <rect x="100" y="18" width="18" height="44" />
            <rect x="112" y="30" width="6" height="20" />
          </g>
          <g fill="rgba(255,255,255,0.22)">
            <circle cx="60" cy="40" r="0.7" />
            <circle cx="14" cy="40" r="0.7" />
            <circle cx="106" cy="40" r="0.7" />
          </g>

          {/* Defending side */}
          <g fill="#5b5d78" opacity="0.75">
            {[[114, 40], [98, 22], [98, 34], [98, 46], [98, 58], [84, 30], [86, 52]].map(([x, y]) => (
              <circle key={`d${x}-${y}`} cx={x} cy={y} r="2" />
            ))}
          </g>

          {/* Attacking side */}
          <g fill="#7c5cfc">
            {[[8, 40], [26, 16], [26, 32], [26, 48], [26, 64], [48, 26], [48, 40], [50, 56], [74, 62]].map(
              ([x, y]) => (
                <circle key={`a${x}-${y}`} cx={x} cy={y} r="2.2" />
              )
            )}
          </g>

          {/* Build-up into the shot */}
          <polyline
            points="48,40 72,18 88,30"
            fill="none"
            stroke="url(#hpPassLine)"
            strokeWidth="0.7"
            strokeDasharray="2.4 1.8"
            strokeLinecap="round"
          />
          <g fill="#c9b8ff">
            <circle cx="72" cy="18" r="2.2" />
            <circle cx="88" cy="30" r="2.2" />
          </g>

          {/* Shot on goal */}
          <circle cx="112" cy="40" r="9" fill="url(#hpBallGlow)" />
          <line
            x1="89.5"
            y1="31"
            x2="110"
            y2="39.4"
            stroke="#f39c12"
            strokeWidth="0.8"
            strokeLinecap="round"
          />
          <path d="M110.4 39.6 L106.6 38.8 L107.9 41.9 Z" fill="#f39c12" />
          <circle cx="112" cy="40" r="1.5" fill="#ffce7a" />

          </g>
        </svg>

        {/* Broadcast overlay */}
        <div className={styles.frameTop}>
          <div className={styles.score}>
            <span className={styles.team}>INT</span>
            <span className={styles.goals}>2</span>
            <span className={styles.dash}>–</span>
            <span className={styles.goals}>0</span>
            <span className={styles.team}>BAY</span>
          </div>
          <div className={styles.ocrBadge}>
            <span className={styles.pulse} />
            CLOCK LOCKED
          </div>
        </div>

        <div className={styles.clock}>
          <span className={styles.clockTime}>70:12</span>
          <span className={styles.clockHalf}>2ND HALF</span>
        </div>

        <div className={styles.frameBottom}>
          <span className={styles.playBtn}>
            <svg viewBox="0 0 12 12" width="9" height="9" fill="currentColor">
              <path d="M2.5 1.2 L10 6 L2.5 10.8 Z" />
            </svg>
          </span>
          <span className={styles.scrub}>
            <span className={styles.scrubFill} style={{ width: `${PLAYHEAD}%` }} />
            <span className={styles.scrubHandle} style={{ left: `${PLAYHEAD}%` }} />
          </span>
          <span className={styles.runtime}>70:12 / 95:00</span>
        </div>
      </div>

      {/* ── Synced timeline ──────────────────────────────────────────── */}
      <div className={styles.timelinePanel}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>Synced events</span>
          <span className={styles.panelMeta}>seek to any marker</span>
        </div>

        <div className={styles.track}>
          <span className={styles.divider} style={{ left: `${HALF_TIME}%` }} />
          {MARKERS.map((m, i) => (
            <span
              key={i}
              className={`${styles.marker} ${m.big ? styles.markerBig : ""}`}
              style={{
                left: `${m.left}%`,
                backgroundColor: TYPE_COLORS[m.type] ?? TYPE_COLORS.default,
              }}
            />
          ))}
          <span className={styles.playhead} style={{ left: `${PLAYHEAD}%` }} />
        </div>

        <div className={styles.ticks}>
          {TICKS.map((t) => (
            <span key={t} style={{ left: `${pct(t)}%` }}>
              {t}&#39;
            </span>
          ))}
        </div>

        <div className={styles.legend}>
          {LEGEND.map((type) => (
            <span key={type} className={styles.legendItem}>
              <i style={{ backgroundColor: TYPE_COLORS[type] ?? TYPE_COLORS.default }} />
              {type}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
