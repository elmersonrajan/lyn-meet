import React, { useEffect, useRef } from "react";

export default function InstructorVideo({
  stream,
  name,
  disconnected,
  playAudio = false,
  iceState,
}) {
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
        video.play().catch((err) => console.warn("[InstructorVideo] video.play", err.message));
        if (playAudio) audio?.play().catch((err) => console.warn("[InstructorVideo] audio.play", err.message));
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

  const liveVideo = Boolean(stream && stream.getVideoTracks().some((t) => t.readyState === "live"));
  const iceBad = iceState === "failed" || iceState === "disconnected";

  return (
    <div>
      <div className="side-head">Instructor Video</div>
      <div className="instructor">
        {liveVideo ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted />
            {playAudio ? <audio ref={audioRef} autoPlay /> : null}
          </>
        ) : (
          <div className="empty">
            {disconnected
              ? "Teacher reconnecting… cloud recording continues"
              : iceBad
                ? "Media path failed (router UDP 40000–49999 / TURN 3478). Click page once after ports open."
                : `${name || "Teacher"} camera is off — click the page once`}
          </div>
        )}
      </div>
    </div>
  );
}
