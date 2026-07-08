import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  checkFootballia,
  searchFootballiaTeams,
  listFootballiaAllMatches,
  startFootballiaDownload,
  footballiaDownloadStatus,
  registerServerVideo,
  API_URL,
} from "../services/api";
import styles from "./FootballiaSearch.module.css";

function fmtBytes(n) {
  if (!n) return "0 MB";
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

// Footballia's team autocomplete matches ONE team, so a two-team query like
// "Argentina Belgium" or "Argentina vs Belgium" returns nothing. Split off an
// explicit separator ("vs", "-", ",") into {first, rest} so we can search the
// first team and use the rest as an opponent filter.
function splitOnSeparator(q) {
  const m = q.match(/^(.+?)\s+(?:vs\.?|versus|v\.?|[-–,])\s+(.+)$/i);
  return m ? { first: m[1].trim(), rest: m[2].trim() } : null;
}

// Search Footballia for a team, then narrow that team's available matches by
// season and competition, and download the full match straight into the app.
export default function FootballiaSearch({ onVideoUploaded }) {
  const [available, setAvailable] = useState(null); // null=checking

  const [query, setQuery]     = useState("");
  const [teams, setTeams]     = useState([]);
  const [searching, setSearching] = useState(false);
  const [team, setTeam]       = useState(null); // selected {name, slug}

  const [allMatches, setAllMatches]   = useState([]);
  const [competitions, setCompetitions] = useState([]);
  const [seasons, setSeasons]         = useState([]);
  const [dataFiltered, setDataFiltered] = useState(true);
  const [seasonFilter, setSeasonFilter]           = useState("all");
  const [competitionFilter, setCompetitionFilter] = useState("all");
  const [opponentFilter, setOpponentFilter]       = useState("");
  const [loadingMatches, setLoadingMatches] = useState(false);

  const [job, setJob]         = useState(null); // {status, progress, ...}
  const [downloadingUrl, setDownloadingUrl] = useState(null); // match url in progress
  const [error, setError]     = useState(null);

  const debounceRef = useRef(null);
  const pollRef     = useRef(null);
  // Opponent parsed from a two-team query, applied once a team is picked.
  const pendingOpponentRef = useRef("");

  useEffect(() => {
    checkFootballia()
      .then((r) => setAvailable(r.data.available))
      .catch(() => setAvailable(false));
    return () => clearInterval(pollRef.current);
  }, []);

  // ── Team autocomplete (debounced) ───────────────────────────────────────
  useEffect(() => {
    if (team) return; // don't re-search once a team is picked
    clearTimeout(debounceRef.current);
    if (query.trim().length < 2) { setTeams([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const q = query.trim();
        // Prefer an explicit separator ("Argentina vs Belgium"); otherwise
        // search the whole query first.
        const sep = splitOnSeparator(q);
        let term = sep ? sep.first : q;
        let opponent = sep ? sep.rest : "";

        let found = (await searchFootballiaTeams(term)).data.teams || [];

        // No explicit separator but a multi-word query that found nothing —
        // it's probably "Team Opponent" (e.g. "Argentina Belgium"). Drop
        // trailing words one at a time and retry, treating the tail as the
        // opponent. (Team names can be multi-word, so we can't split blindly.)
        if (found.length === 0 && !sep && /\s/.test(q)) {
          const words = q.split(/\s+/);
          for (let cut = words.length - 1; cut >= 1 && found.length === 0; cut--) {
            term = words.slice(0, cut).join(" ");
            opponent = words.slice(cut).join(" ");
            found = (await searchFootballiaTeams(term)).data.teams || [];
          }
        }

        pendingOpponentRef.current = found.length ? opponent : "";
        setTeams(found);
      } catch {
        setTeams([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, team]);

  const loadAllMatches = useCallback(async (slug) => {
    setLoadingMatches(true);
    setError(null);
    setAllMatches([]);
    try {
      const { data } = await listFootballiaAllMatches(slug);
      setAllMatches(data.matches || []);
      setCompetitions(data.competitions || []);
      setSeasons(data.seasons || []);
      setDataFiltered(data.data_filtered !== false);
    } catch (err) {
      setError(err.response?.data?.error ?? "Could not load matches.");
    } finally {
      setLoadingMatches(false);
    }
  }, []);

  const selectTeam = useCallback((t) => {
    setTeam(t);
    setTeams([]);
    setQuery(t.name);
    setSeasonFilter("all");
    setCompetitionFilter("all");
    // Carry over an opponent parsed from a two-team query so the list is
    // pre-narrowed (e.g. "Argentina Belgium" → team Argentina, opponent Belgium).
    setOpponentFilter(pendingOpponentRef.current);
    pendingOpponentRef.current = "";
    loadAllMatches(t.slug);
  }, [loadAllMatches]);

  const resetTeam = useCallback(() => {
    setTeam(null);
    setAllMatches([]);
    setCompetitions([]);
    setSeasons([]);
    setQuery("");
    setTeams([]);
    setOpponentFilter("");
  }, []);

  // ── Client-side filtering ───────────────────────────────────────────────
  const filteredMatches = useMemo(() => {
    const opp = opponentFilter.trim().toLowerCase();
    return allMatches.filter(
      (m) =>
        (seasonFilter === "all" || m.season === seasonFilter) &&
        (competitionFilter === "all" || m.competition === competitionFilter) &&
        (!opp || m.title.toLowerCase().includes(opp))
    );
  }, [allMatches, seasonFilter, competitionFilter, opponentFilter]);

  // ── Download + poll ─────────────────────────────────────────────────────
  const handleDownload = useCallback(async (m) => {
    setError(null);
    setDownloadingUrl(m.url);
    setJob({ status: "starting", progress: 0 });
    try {
      const { data } = await startFootballiaDownload(m.url, m.title);
      const jobId = data.job_id;
      pollRef.current = setInterval(async () => {
        try {
          const { data: s } = await footballiaDownloadStatus(jobId);
          setJob(s);
          if (s.status === "done") {
            clearInterval(pollRef.current);
            const { data: reg } = await registerServerVideo(s.filename);
            const videoUrl = `${API_URL}/api/video/stream/${s.filename}`;
            onVideoUploaded(videoUrl, reg.match_info, reg.filename);
            setDownloadingUrl(null);
            setJob(null);
          } else if (s.status === "error") {
            clearInterval(pollRef.current);
            setError(s.error || "Download failed.");
            setDownloadingUrl(null);
            setJob(null);
          }
        } catch {
          clearInterval(pollRef.current);
          setError("Lost contact with the download.");
          setDownloadingUrl(null);
          setJob(null);
        }
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.error ?? "Could not start download.");
      setDownloadingUrl(null);
      setJob(null);
    }
  }, [onVideoUploaded]);

  const statusLabel = (s) => {
    if (!s) return "";
    if (s.status === "resolving" || s.status === "starting") return "Preparing…";
    if (s.status === "downloading")
      return `Downloading ${fmtBytes(s.downloaded)} / ${fmtBytes(s.total)} (${s.progress}%)`;
    if (s.status === "processing") return "Joining halves…";
    return s.status;
  };

  if (available === false) {
    return (
      <div className={styles.wrap}>
        <p className={styles.unavailable}>
          Footballia search needs a <code>footballia.net_cookies.txt</code> file
          at the project root. Export your logged-in cookies (see
          <code> download_footballia.py</code>) and restart the server.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.searchRow}>
        <input
          className={styles.input}
          placeholder="Search a team (e.g. Argentina, Real Madrid)…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (team) resetTeam(); }}
          disabled={available === null}
        />
        {team && (
          <button className={styles.clearBtn} onClick={resetTeam} title="New search">✕</button>
        )}
      </div>

      {/* Team suggestions */}
      {!team && teams.length > 0 && (
        <ul className={styles.teamList}>
          {teams.map((t) => (
            <li key={t.slug}>
              <button className={styles.teamBtn} onClick={() => selectTeam(t)}>
                {t.logo && <img className={styles.logo} src={t.logo} alt="" />}
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!team && searching && <p className={styles.hint}>Searching…</p>}

      {/* Active download progress */}
      {job && (
        <div className={styles.downloadBox}>
          <span className={styles.downloadLabel}>{statusLabel(job)}</span>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${job.progress || (job.status === "processing" ? 100 : 0)}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {/* Filters + match list */}
      {team && (
        <div className={styles.matchesWrap}>
          {loadingMatches ? (
            <p className={styles.hint}>Finding {team.name} matches with StatsBomb data…</p>
          ) : allMatches.length === 0 ? (
            <p className={styles.hint}>
              No StatsBomb-covered matches found for {team.name}. StatsBomb’s open
              data only covers select competitions/seasons.
            </p>
          ) : (
            <>
              <div className={styles.filters}>
                <input
                  className={styles.input}
                  placeholder="Filter by opponent (e.g. Belgium)"
                  value={opponentFilter}
                  onChange={(e) => setOpponentFilter(e.target.value)}
                />
              </div>
              <div className={styles.filters}>
                <select
                  className={styles.filterSelect}
                  value={competitionFilter}
                  onChange={(e) => setCompetitionFilter(e.target.value)}
                >
                  <option value="all">All competitions</option>
                  {competitions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  className={styles.filterSelect}
                  value={seasonFilter}
                  onChange={(e) => setSeasonFilter(e.target.value)}
                >
                  <option value="all">All seasons</option>
                  {seasons.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className={styles.resultCount}>
                {filteredMatches.length} match{filteredMatches.length !== 1 ? "es" : ""}
                {(seasonFilter !== "all" || competitionFilter !== "all" || opponentFilter.trim()) &&
                  ` of ${allMatches.length}`}
                {dataFiltered && " · with StatsBomb data"}
              </div>

              {filteredMatches.length === 0 ? (
                <p className={styles.hint}>No matches for this filter.</p>
              ) : (
                <ul className={styles.matchList}>
                  {filteredMatches.map((m) => (
                    <li key={m.url} className={styles.matchRow}>
                      <div className={styles.matchInfo}>
                        <span className={styles.matchTitle}>{m.title}</span>
                        <span className={styles.matchMeta}>
                          {[m.competition, m.stage, m.date || m.season]
                            .filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      <button
                        className={styles.dlBtn}
                        onClick={() => handleDownload(m)}
                        disabled={!!downloadingUrl}
                        title={downloadingUrl ? "A download is in progress" : "Download & load this match"}
                      >
                        {downloadingUrl === m.url ? "…" : "Download"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
