import React, { useState, useEffect, useCallback, useMemo } from "react";
import { searchMatches, fetchEvents } from "../services/api";
import styles from "./MatchSelector.module.css";

// ── Confidence metadata ───────────────────────────────────────────────────────

const CONFIDENCE_META = {
  ocr_high:   { label: "OCR — high confidence",    color: "#4ecca3", icon: "◉", description: "Teams read directly from the on-screen scoreboard." },
  ocr_medium: { label: "OCR — moderate confidence", color: "#f39c12", icon: "◎", description: "Scoreboard detected but team names may need verification." },
  ocr_low:    { label: "OCR — low confidence",      color: "#e67e22", icon: "○", description: "Scoreboard text was found but couldn't be parsed clearly." },
  filename:   { label: "Filename detection",         color: "#3498db", icon: "◈", description: "Teams inferred from the video filename." },
  none:       { label: "Not detected",               color: "#666",    icon: "◌", description: "No automatic detection. Enter a team name to search." },
};

function getMeta(c) { return CONFIDENCE_META[c] ?? CONFIDENCE_META.none; }

/**
 * Parse a query string into { team1, team2 }.
 * "Barcelona vs Juventus"  → { team1: "Barcelona", team2: "Juventus" }
 * "Barcelona"              → { team1: "Barcelona", team2: "" }
 */
function parseQuery(q) {
  const vsMatch = q.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (vsMatch) return { team1: vsMatch[1].trim(), team2: vsMatch[2].trim() };
  return { team1: q.trim(), team2: "" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MatchSelector({ matchInfo, onMatchSelected }) {
  const confidence = matchInfo?.confidence ?? "none";
  const teams      = matchInfo?.detected_teams ?? [];
  const ocrText    = matchInfo?.ocr_raw_text;
  const ocrBackend = matchInfo?.ocr_backend;
  const meta       = getMeta(confidence);

  const [query, setQuery]           = useState("");
  const [competition, setCompetition] = useState("");
  const [allResults, setAllResults] = useState([]);   // raw from backend
  const [searching, setSearching]   = useState(false);
  const [loadingId, setLoadingId]   = useState(null);
  const [error, setError]           = useState(null);

  // Auto-search on mount if teams were detected
  useEffect(() => {
    if (teams.length >= 2) {
      const seed = `${teams[0]} vs ${teams[1]}`;
      setQuery(seed);
      runSearch(seed, "");
    } else if (teams.length === 1) {
      setQuery(teams[0]);
      runSearch(teams[0], "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q, comp) => {
    const { team1 } = parseQuery(q);
    if (!team1 && !comp?.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const { data } = await searchMatches(team1, comp?.trim());
      const list = Array.isArray(data) ? data : (data.matches ?? []);
      setAllResults(list);
    } catch {
      setError("Search failed — is the backend running?");
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSearch = useCallback(() => {
    runSearch(query, competition);
  }, [runSearch, query, competition]);

  // ── Client-side filtering by team2 + competition ──────────────────────────

  const results = useMemo(() => {
    const { team2 } = parseQuery(query);
    let list = allResults;

    // Filter by second team if the query contained "vs"
    if (team2) {
      const t2 = team2.toLowerCase();
      list = list.filter(
        (m) =>
          m.home_team.toLowerCase().includes(t2) ||
          m.away_team.toLowerCase().includes(t2)
      );
    }

    // Filter by competition input (redundant if backend already filtered, but
    // handles the case where the user types it after receiving results)
    if (competition.trim()) {
      const c = competition.trim().toLowerCase();
      list = list.filter((m) => m.competition.toLowerCase().includes(c));
    }

    return list;
  }, [allResults, query, competition]);

  // ── Load events ───────────────────────────────────────────────────────────

  const handleSelect = useCallback(async (match) => {
    setLoadingId(match.match_id);
    setError(null);
    try {
      const { data } = await fetchEvents(match.match_id);
      const events = Array.isArray(data) ? data : (data.events ?? []);
      onMatchSelected(match.match_id, events);
    } catch {
      setError("Failed to fetch events for this match.");
    } finally {
      setLoadingId(null);
    }
  }, [onMatchSelected]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrapper}>

      {/* Detection banner */}
      <div className={styles.detectionBanner} style={{ borderColor: meta.color }}>
        <span className={styles.detectionIcon} style={{ color: meta.color }}>{meta.icon}</span>
        <div className={styles.detectionBody}>
          <span className={styles.detectionLabel} style={{ color: meta.color }}>
            {meta.label}
            {ocrBackend && ocrBackend !== "none" && (
              <span className={styles.backendTag}>{ocrBackend}</span>
            )}
          </span>
          <span className={styles.detectionDesc}>{meta.description}</span>
          {teams.length > 0 && (
            <span className={styles.detectedTeams}>
              {teams.join(" vs ")}{matchInfo?.detected_date && ` — ${matchInfo.detected_date}`}
            </span>
          )}
          {ocrText && (
            <details className={styles.rawOcr}>
              <summary>Raw OCR text</summary>
              <code>{ocrText}</code>
            </details>
          )}
        </div>
      </div>

      {/* Search fields */}
      <div className={styles.fields}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Teams</label>
          <input
            className={styles.input}
            type="text"
            placeholder="Barcelona vs Juventus"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Competition <span className={styles.optional}>(optional)</span></label>
          <input
            className={styles.input}
            type="text"
            placeholder="Champions League"
            value={competition}
            onChange={(e) => setCompetition(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
        <button className={styles.searchBtn} onClick={handleSearch} disabled={searching}>
          {searching ? <span className={styles.spinner} /> : "Search"}
        </button>
      </div>

      {/* Hint about "vs" syntax */}
      <p className={styles.hint}>
        Tip: type <strong>Team A vs Team B</strong> to match both teams at once.
      </p>

      {error && <p className={styles.error}>{error}</p>}

      {/* Results */}
      {!searching && results.length > 0 && (
        <>
          <p className={styles.resultCount}>
            {results.length} match{results.length !== 1 ? "es" : ""}
            {allResults.length !== results.length && ` (filtered from ${allResults.length})`}
          </p>
          <ul className={styles.results}>
            {results.map((m) => {
              const loading    = loadingId === m.match_id;
              const anyLoading = loadingId !== null;
              return (
                <li key={m.match_id} className={styles.result}>
                  <div className={styles.matchInfo}>
                    <span className={styles.teams}>
                      {m.home_team}
                      {m.home_score != null && (
                        <span className={styles.score}> {m.home_score}–{m.away_score} </span>
                      )}
                      {m.away_team}
                    </span>
                    <span className={styles.meta}>
                      {m.competition} · {m.season} · {m.match_date}
                    </span>
                  </div>
                  <button
                    className={styles.selectBtn}
                    onClick={() => handleSelect(m)}
                    disabled={anyLoading}
                  >
                    {loading ? <span className={styles.spinner} /> : "Load events"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {!searching && allResults.length > 0 && results.length === 0 && (
        <p className={styles.status}>No matches after filtering. Try broadening your search.</p>
      )}

      {!searching && allResults.length === 0 && query.trim() && (
        <p className={styles.status}>No matches found. Try a different team name.</p>
      )}
    </div>
  );
}
