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

export const scanClock = (filename) =>
  api.post("/video/scan-clock", { filename }, { timeout: 300_000 }); // 5-min timeout

export const checkScanAvailable = () => api.get("/video/scan-check");
