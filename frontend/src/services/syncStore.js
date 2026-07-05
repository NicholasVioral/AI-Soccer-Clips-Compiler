// Dev convenience: remembers the manual half-sync offsets per video in the
// browser (localStorage), so you don't have to re-enter the sync every reload
// while iterating on clip logic. Keyed by video filename.
//
// To remove this feature entirely: delete this file and the two blocks marked
// "SYNC PERSIST" in App.jsx (revert them to `setHalfOffsets({ 1: null, 2: null })`).

const KEY_PREFIX = "scc:sync:";
const EMPTY = { 1: null, 2: null };

// Known-good manual sync (offsets in seconds: video_time − match_time) for
// videos being iterated on. Used as a fallback when nothing is saved yet, so
// the sync is present even on the very first load without re-entering it.
// localStorage overrides these once you set/re-sync a half.
const SEED_OFFSETS = {
  "real_madrid_barcelona_2005_2006.mp4": { 1: 40, 2: 198 }, // 1st +0:40, 2nd +3:18
};

const keyFor = (filename) => KEY_PREFIX + filename;

// Load saved { 1, 2 } offsets for a video, falling back to a seed value, then a
// blank pair if none exists/is invalid.
export function loadSavedOffsets(filename) {
  if (!filename) return { ...EMPTY };
  try {
    const raw = localStorage.getItem(keyFor(filename));
    if (!raw) return { ...(SEED_OFFSETS[filename] ?? EMPTY) };
    const parsed = JSON.parse(raw);
    const norm = (v) => (typeof v === "number" && isFinite(v) ? v : null);
    return { 1: norm(parsed["1"]), 2: norm(parsed["2"]) };
  } catch {
    return { ...(SEED_OFFSETS[filename] ?? EMPTY) };
  }
}

// Persist { 1, 2 } offsets for a video. Removes the entry when both are null
// (e.g. after re-syncing both halves), so a cleared sync stays cleared.
export function saveOffsets(filename, offsets) {
  if (!filename) return;
  try {
    if (offsets?.[1] == null && offsets?.[2] == null) {
      localStorage.removeItem(keyFor(filename));
    } else {
      localStorage.setItem(keyFor(filename), JSON.stringify(offsets));
    }
  } catch {
    /* ignore storage errors (private mode, quota) */
  }
}

// Explicitly forget a video's saved sync.
export function clearSavedOffsets(filename) {
  if (!filename) return;
  try {
    localStorage.removeItem(keyFor(filename));
  } catch {
    /* ignore */
  }
}
