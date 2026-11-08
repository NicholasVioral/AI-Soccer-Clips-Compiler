/**
 * Convert a match time to a video position using the scanned clock map.
 * Mirrors backend services/clock_scanner.interpolate_video_time — keep the
 * two in sync so seeking and clip generation land on the same frames.
 *
 * The readings are split into continuous chunks at splice points (halftime
 * cut out of the recording, missing footage): within one chunk the broadcast
 * clock runs 1:1 with the video, so a single median offset maps exactly,
 * cancels per-reading OCR jitter, and extends to match times before the first
 * or after the last reading. Match times around a splice are ambiguous
 * (first-half stoppage and the start of the second half share clock values),
 * so `period` picks the chunk when chunks line up with halves.
 *
 * Returns null if the map is empty or the match time is out of reach.
 */

// A splice shows up as adjacent readings whose video gap and match gap
// disagree by more than this many seconds.
const SPLICE_TOLERANCE = 45;

// Don't map match times further than this beyond a chunk's scanned range.
const MAX_EXTRAPOLATION = 600;

// Offset spread within a chunk beyond which we assume hidden cuts and fall
// back to pairwise interpolation.
const MAX_OFFSET_SPREAD = 6;

export function interpolateVideoTime(matchSeconds, clockMap, period = null) {
  if (!clockMap || clockMap.length === 0) return null;

  const sorted = [...clockMap].sort((a, b) => a.video_seconds - b.video_seconds);

  // Split into continuous 1:1 chunks at splice points.
  const segments = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const dVideo = sorted[i].video_seconds - sorted[i - 1].video_seconds;
    const dMatch = sorted[i].match_seconds - sorted[i - 1].match_seconds;
    if (Math.abs(dVideo - dMatch) > SPLICE_TOLERANCE) segments.push([]);
    segments[segments.length - 1].push(sorted[i]);
  }

  const inReach = (seg) =>
    seg[0].match_seconds - MAX_EXTRAPOLATION <= matchSeconds &&
    matchSeconds <= seg[seg.length - 1].match_seconds + MAX_EXTRAPOLATION;
  const candidates = segments.filter(inReach);
  if (candidates.length === 0) return null;

  // Prefer the period-th chunk (splices normally sit at half boundaries);
  // otherwise the chunk whose scanned range is closest.
  let seg = null;
  if (period && period >= 1 && period <= segments.length &&
      candidates.includes(segments[period - 1])) {
    seg = segments[period - 1];
  }
  if (!seg) {
    const dist = (sg) => {
      const lo = sg[0].match_seconds;
      const hi = sg[sg.length - 1].match_seconds;
      if (matchSeconds < lo) return lo - matchSeconds;
      if (matchSeconds > hi) return matchSeconds - hi;
      return 0;
    };
    seg = candidates.reduce((best, sg) => (dist(sg) < dist(best) ? sg : best));
  }

  const offsets = seg
    .map((e) => e.video_seconds - e.match_seconds)
    .sort((a, b) => a - b);
  if (offsets[offsets.length - 1] - offsets[0] <= MAX_OFFSET_SPREAD) {
    const mid = Math.floor(offsets.length / 2);
    const median =
      offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
    return matchSeconds + median;
  }

  // Jittery chunk (possible hidden cuts): pairwise interpolation, extending
  // 1:1 beyond the ends.
  const lo = seg[0];
  const hi = seg[seg.length - 1];
  if (matchSeconds <= lo.match_seconds) {
    return lo.video_seconds - (lo.match_seconds - matchSeconds);
  }
  if (matchSeconds >= hi.match_seconds) {
    return hi.video_seconds + (matchSeconds - hi.match_seconds);
  }
  for (let i = 0; i < seg.length - 1; i++) {
    const a = seg[i];
    const b = seg[i + 1];
    if (a.match_seconds <= matchSeconds && matchSeconds <= b.match_seconds) {
      const span = b.match_seconds - a.match_seconds;
      if (span === 0) return a.video_seconds;
      const frac = (matchSeconds - a.match_seconds) / span;
      return a.video_seconds + frac * (b.video_seconds - a.video_seconds);
    }
  }
  return hi.video_seconds;
}
