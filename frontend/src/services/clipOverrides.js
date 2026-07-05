// Per-event manual video-time overrides, stored in the browser and keyed by
// video filename. When StatsBomb's timing is off for a specific event, the user
// pins it to the correct video time in Player Highlights; that value is sent to
// the backend, which shifts the whole clip to land there.
//
// Shape in storage: { [eventId]: videoSeconds }

const KEY_PREFIX = "scc:overrides:";

const keyFor = (filename) => KEY_PREFIX + filename;

// Parse a "M:SS", "MM:SS", or "H:MM:SS" string (minutes may exceed 59, e.g.
// "80:26") into seconds. Returns null if it can't be parsed.
export function parseVideoTime(text) {
  if (text == null) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  let seconds;
  if (nums.length === 1) seconds = nums[0];
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else return null;
  return isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Load { eventId: seconds } overrides for a video, or {} if none/invalid.
export function loadOverrides(filename) {
  if (!filename) return {};
  try {
    const raw = localStorage.getItem(keyFor(filename));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (typeof v === "number" && isFinite(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Persist the full { eventId: seconds } map for a video (removes the entry when
// empty so a cleared set of overrides stays cleared).
export function saveOverrides(filename, overrides) {
  if (!filename) return;
  try {
    if (!overrides || Object.keys(overrides).length === 0) {
      localStorage.removeItem(keyFor(filename));
    } else {
      localStorage.setItem(keyFor(filename), JSON.stringify(overrides));
    }
  } catch {
    /* ignore storage errors (private mode, quota) */
  }
}
