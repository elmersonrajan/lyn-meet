import React, { useEffect, useRef } from "react";

export default function InstructorVideo({ stream, name, disconnected }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    try {
      const v = videoRef.current;
      const a = audioRef.current;
      if (!v) return;
      v.srcObject = stream || null;
      if (a) {
        if (stream) {
          const audioOnly = new MediaStream(stream.getAudioTracks());
          a.srcObject = audioOnly.getAudioTracks().length ? audioOnly : null;
        } else {
          a.srcObject = null;
        }
      }
      const play = async () => {
        try {
          await v.play();
          await a?.play();
        } catch (err) {
          console.warn("[InstructorVideo] autoplay blocked, click page", err);
        }
      };
      play();
    } catch (err) {
      console.error("[InstructorVideo] attach failed", err);
    }
  }, [stream]);

  return (
    <div>
      <div className="side-head">Instructor Video</div>
      <div className="instructor">
        {stream ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted />
            <audio ref={audioRef} autoPlay />
          </>
        ) : (
          <div className="empty">
            {disconnected
              ? "Teacher reconnecting… cloud recording continues"
              : `${name || "Teacher"} camera is off`}
          </div>
        )}
      </div>
    </div>
  );
}