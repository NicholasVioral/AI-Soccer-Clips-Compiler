import axios from "axios";

// Backend origin. In production set VITE_API_URL to the deployed Flask URL
// (e.g. https://your-app.onrender.com); falls back to the local Flask dev
// server. Exported so non-axios URLs (downloads, video <src>) can share it.
export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:5000";

// "/api" matches the blueprints' url_prefix on the Flask backend.
export const api = axios.create({ baseURL: `${API_URL}/api` });

export const uploadVideo = (file, onProgress) => {
  const form = new FormData();
  form.append("video", file);
  return api.post("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (e) => {
      if (onProgress && e.total) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    },
  });
};

export const searchMatches = (team = "", competition = "") =>
  api.get("/search-matches", { params: { team, competition } });

export const fetchEvents = (matchId) =>
  api.get("/events", { params: { match_id: matchId } });

export const fetchCompetitions = () => api.get("/competitions");

export const fetchMatches = (competitionId, seasonId) =>
  api.get("/matches", { params: { competition_id: competitionId, season_id: seasonId } });

export const generateClips = (payload) =>
  api.post("/clips/generate", payload);

export const checkFfmpeg = () => api.get("/clips/check");

// ── External clips (YouTube etc.) ──────────────────────────────────────────
// Downloading a section can take a while over the network, so allow 5 min.
export const addExternalClip = ({ url, start, end, label }) =>
  api.post("/external-clips", { url, start, end, label }, { timeout: 300_000 });

export const deleteExternalClip = (id) => api.delete(`/external-clips/${id}`);

export const checkExternalClips = () => api.get("/external-clips/check");

// Direct URL for previewing / <video src> — bypasses axios.
export const externalClipUrl = (id) => `${API_URL}/api/external-clips/${id}`;

export const scanClock = (filename) =>
  api.post("/video/scan-clock", { filename }, { timeout: 300_000 }); // 5-min timeout

export const checkScanAvailable = () => api.get("/video/scan-check");

// Register a file already sitting in the uploads folder (e.g. one downloaded
// from Footballia) so the app can load it. Returns { filename, match_info }.
export const registerServerVideo = (filename) =>
  api.post("/upload/register", { filename });

// ── Footballia integration ─────────────────────────────────────────────────
export const checkFootballia = () => api.get("/footballia/check");

export const searchFootballiaTeams = (name) =>
  api.get("/footballia/search-teams", { params: { name } });

export const listFootballiaMatches = (slug, page = 1) =>
  api.get("/footballia/matches", { params: { slug, page } });

// All of a team's matches plus the distinct seasons/competitions for filtering.
// Fetches every page server-side (cached), so allow a longer timeout.
export const listFootballiaAllMatches = (slug) =>
  api.get("/footballia/all-matches", { params: { slug }, timeout: 60_000 });

export const startFootballiaDownload = (matchUrl, title) =>
  api.post("/footballia/download", { match_url: matchUrl, title });

export const footballiaDownloadStatus = (jobId) =>
  api.get(`/footballia/download/${jobId}`);
