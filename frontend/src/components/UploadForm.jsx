import React, { useState, useCallback } from "react";
import { uploadVideo } from "../services/api";
import styles from "./UploadForm.module.css";

export default function UploadForm({ onVideoUploaded }) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      setError(null);
      setUploading(true);
      setProgress(0);

      const localUrl = URL.createObjectURL(file);

      try {
        const { data } = await uploadVideo(file, setProgress);
        onVideoUploaded(localUrl, data.match_info, data.filename);
      } catch (err) {
        setError(err.response?.data?.error ?? "Upload failed. Please try again.");
        URL.revokeObjectURL(localUrl);
      } finally {
        setUploading(false);
      }
    },
    [onVideoUploaded]
  );

  const onInputChange = (e) => handleFile(e.target.files[0]);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      handleFile(e.dataTransfer.files[0]);
    },
    [handleFile]
  );

  return (
    <div>
      <label
        className={`${styles.dropzone} ${dragging ? styles.over : ""} ${uploading ? styles.disabled : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept="video/*"
          className={styles.fileInput}
          onChange={onInputChange}
          disabled={uploading}
        />
        <span className={styles.icon}>&#127909;</span>
        <span className={styles.label}>
          {uploading
            ? `Uploading... ${progress}%`
            : "Drag & drop a match video or click to browse"}
        </span>
        <span className={styles.hint}>MP4, MKV, AVI, MOV, WebM — up to 2 GB</span>
      </label>

      {uploading && (
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
