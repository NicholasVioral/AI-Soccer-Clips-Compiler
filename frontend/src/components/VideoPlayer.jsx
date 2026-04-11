import React from "react";
import styles from "./VideoPlayer.module.css";

export default function VideoPlayer({ videoRef, src, onTimeUpdate, onDurationChange }) {
  return (
    <div className={styles.wrapper}>
      <video
        ref={videoRef}
        className={styles.video}
        src={src}
        controls
        onTimeUpdate={(e) => onTimeUpdate(e.target.currentTime)}
        onDurationChange={(e) => onDurationChange(e.target.duration)}
      />
    </div>
  );
}
