import React, { useState, useCallback } from "react";
import { addExternalClip, deleteExternalClip, externalClipUrl } from "../services/api";
import { parseVideoTime } from "../services/clipOverrides";
import styles from "./ExternalClips.module.css";

function fmtDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// A standalone, manually-ordered list of external clips (e.g. a YouTube
// celebration in HD) to splice into the compiled reel. Clips are downloaded on
// the backend when added; the ordered list here is sent to clip generation.
export default function ExternalClips({ clips, setClips, placement, setPlacement }) {
  const [url, setUrl]     = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd]     = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError]   = useState(null);
  const [preview, setPreview] = useState(null); // clip id being previewed

  const handleAdd = useCallback(async () => {
    setError(null);
    const startSec = parseVideoTime(start);
    const endSec   = parseVideoTime(end);
    if (!url.trim()) { setError("Paste a video URL."); return; }
    if (startSec == null || endSec == null) {
      setError("Enter start and end times (seconds or M:SS).");
      return;
    }
    if (endSec <= startSec) { setError("End must be after start."); return; }

    setAdding(true);
    try {
      const { data } = await addExternalClip({
        url: url.trim(),
        start: startSec,
        end: endSec,
        label: label.trim(),
      });
      setClips((prev) => [...prev, data]);
      // Keep the URL (often adding several clips from one video); clear times.
      setStart("");
      setEnd("");
      setLabel("");
    } catch (err) {
      setError(err.response?.data?.error ?? "Download failed — check the URL and times.");
    } finally {
      setAdding(false);
    }
  }, [url, start, end, label, setClips]);

  const move = useCallback((idx, dir) => {
    setClips((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }, [setClips]);

  const remove = useCallback(async (id) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    if (preview === id) setPreview(null);
    try { await deleteExternalClip(id); } catch { /* best-effort cleanup */ }
  }, [setClips, preview]);

  return (
    <div className={styles.wrap}>
      <div className={styles.headerRow}>
        <span className={styles.title}>External clips</span>
        {clips.length > 0 && (
          <span className={styles.count}>{clips.length} added</span>
        )}
      </div>
      <p className={styles.hint}>
        Add an HD clip from YouTube (or any video URL) to splice into the reel —
        e.g. a celebration. Paste the link and the start/end times.
      </p>

      {/* ── Add form ───────────────────────────────────────────────────── */}
      <input
        className={styles.input}
        placeholder="Video URL (e.g. https://youtube.com/watch?v=…)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        spellCheck={false}
      />
      <div className={styles.timeRow}>
        <input
          className={styles.timeInput}
          placeholder="Start (0:43)"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <span className={styles.dash}>–</span>
        <input
          className={styles.timeInput}
          placeholder="End (0:46)"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
        <input
          className={styles.labelInput}
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <button className={styles.addBtn} onClick={handleAdd} disabled={adding}>
        {adding ? (
          <>
            <span className={styles.spinner} /> Downloading…
          </>
        ) : (
          "+ Add clip"
        )}
      </button>

      {/* ── Clip list (manual order) ───────────────────────────────────── */}
      {clips.length > 0 && (
        <>
          <ul className={styles.list}>
            {clips.map((c, idx) => (
              <li key={c.id} className={styles.item}>
                <span className={styles.order}>{idx + 1}</span>
                <div className={styles.itemMain}>
                  <span className={styles.itemLabel}>{c.label}</span>
                  <span className={styles.itemMeta}>{fmtDuration(c.duration)}</span>
                </div>
                <div className={styles.itemBtns}>
                  <button
                    className={styles.iconBtn}
                    title="Preview"
                    onClick={() => setPreview(preview === c.id ? null : c.id)}
                  >
                    ▶
                  </button>
                  <button
                    className={styles.iconBtn}
                    title="Move up"
                    disabled={idx === 0}
                    onClick={() => move(idx, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className={styles.iconBtn}
                    title="Move down"
                    disabled={idx === clips.length - 1}
                    onClick={() => move(idx, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className={`${styles.iconBtn} ${styles.removeBtn}`}
                    title="Remove"
                    onClick={() => remove(c.id)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {preview && (
            <video
              key={preview}
              className={styles.previewVideo}
              src={externalClipUrl(preview)}
              controls
              autoPlay
            />
          )}

          {/* ── Placement in the reel ────────────────────────────────────── */}
          <div className={styles.placementRow}>
            <span className={styles.placementLabel}>Place clips at reel</span>
            <div className={styles.placementChips}>
              <button
                className={`${styles.placementChip} ${placement === "start" ? styles.placementChipActive : ""}`}
                onClick={() => setPlacement("start")}
              >
                Start
              </button>
              <button
                className={`${styles.placementChip} ${placement === "end" ? styles.placementChipActive : ""}`}
                onClick={() => setPlacement("end")}
              >
                End
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
