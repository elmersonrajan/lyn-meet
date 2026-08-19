import React, { useEffect, useRef } from "react";

export default function InstructorVideo({ stream, name, disconnected, playAudio = false }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return undefined;

    try {
      video.srcObject = stream || null;
      if (audio) {
        if (playAudio && stream && stream.getAudioTracks().length) {
          audio.srcObject = new MediaStream(stream.getAudioTracks());
        } else {
          audio.srcObject = null;
        }
      }

      const tryPlay = () => {
        video.play().catch(() => {});
        if (playAudio) audio?.play().catch(() => {});
      };

      video.addEventListener("loadedmetadata", tryPlay);
      const onClick = () => tryPlay();
      document.addEventListener("click", onClick);
      tryPlay();

      return () => {
        video.removeEventListener("loadedmetadata", tryPlay);
        document.removeEventListener("click", onClick);
      };
    } catch (err) {
      console.error("[InstructorVideo] attach failed", err);
    }
    return undefined;
  }, [stream, playAudio]);

  const hasVideo = Boolean(stream && stream.getVideoTracks().some((t) => t.readyState === "live"));

  return (
    <div>
      <div className="side-head">Instructor Video</div>
      <div className="instructor">
        {hasVideo ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted />
            {playAudio ? <audio ref={audioRef} autoPlay /> : null}
          </>
        ) : (
          <div className="empty">
            {disconnected
              ? "Teacher reconnecting… cloud recording continues"
              : `${name || "Teacher"} camera is off — click the page once`}
          </div>
        )}
      </div>
    </div>
  );
}