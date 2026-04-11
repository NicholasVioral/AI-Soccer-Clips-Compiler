/**
 * Given a clock_map (array of {video_seconds, match_seconds} sorted by
 * video_seconds) and a target match time, return the interpolated video
 * position in seconds.  Returns null if out of range or map is empty.
 */
export function interpolateVideoTime(matchSeconds, clockMap) {
  if (!clockMap || clockMap.length === 0) return null;

  const sorted = [...clockMap].sort((a, b) => a.match_seconds - b.match_seconds);

  if (matchSeconds < sorted[0].match_seconds) return null;
  if (matchSeconds > sorted[sorted.length - 1].match_seconds) return null;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.match_seconds <= matchSeconds && matchSeconds <= b.match_seconds) {
      const span = b.match_seconds - a.match_seconds;
      if (span === 0) return a.video_seconds;
      const frac = (matchSeconds - a.match_seconds) / span;
      return a.video_seconds + frac * (b.video_seconds - a.video_seconds);
    }
  }
  return null;
}
