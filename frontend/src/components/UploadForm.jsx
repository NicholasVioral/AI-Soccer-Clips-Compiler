import React, { useState, useCallback, useEffect } from "react";
import { uploadVideo, api, API_URL } from "../services/api";
import styles from "./UploadForm.module.css";

export default function UploadForm({ onVideoUploaded }) {
  const [dragging, setDragging]       = useState(false);
  const [progress, setProgress]       = useState(0);
  const [uploading, setUploading]     = useState(false);
  const [error, setError]             = useState(null);
  const [serverFiles, setServerFiles] = useState([]);
  const [showPicker, setShowPicker]   = useState(false);

  // Load files already in the uploads folder
  useEffect(() => {
    api.get("/upload/list").then(r => setServerFiles(r.data.files || [])).catch(() => {});
  }, []);

  const handleRegister = useCallback(async (filename) => {
    setError(null);
    setUploading(true);
    try {
      const { data } = await api.post("/upload/register", { filename });
      // Remotely hosted videos stream straight from their host (video_url);
      // local server files go through the backend's stream endpoint.
      const videoUrl = data.video_url ?? `${API_URL}/api/video/stream/${filename}`;
      onVideoUploaded(videoUrl, data.match_info, data.filename);
    } catch (err) {
      setError(err.response?.data?.error ?? "Failed to register file.");
    } finally {
      setUploading(false);
    }
  }, [onVideoUploaded]);

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

      {serverFiles.length > 0 && (
        <div className={styles.serverFiles}>
          <button className={styles.serverFilesToggle} onClick={() => setShowPicker(v => !v)}>
            {showPicker ? "▲" : "▼"} Use a file already on the server ({serverFiles.length})
          </button>
          {showPicker && (
            <ul className={styles.fileList}>
              {serverFiles.map(f => (
                <li key={f}>
                  <button className={styles.fileBtn} onClick={() => handleRegister(f)} disabled={uploading}>
                    {f}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
