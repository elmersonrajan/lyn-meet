import React, { useEffect, useRef } from "react";

export default function InstructorVideo({ stream, name, disconnected, muted }) {
  const ref = useRef(null);

  useEffect(() => {
    try {
      if (ref.current) {
        ref.current.srcObject = stream || null;
        ref.current.muted = Boolean(muted);
      }
    } catch (err) {
      console.error("[InstructorVideo] attach failed", err);
    }
  }, [stream, muted]);

  return (
    <div>
      <div className="side-head">Instructor Video</div>
      <div className="instructor">
        {stream ? (
          <video ref={ref} autoPlay playsInline muted={Boolean(muted)} />
        ) : (
          <div className="empty">
            {disconnected
              ? "Teacher reconnecting… meeting continues"
              : `${name || "Teacher"} camera is off`}
          </div>
        )}
      </div>
    </div>
  );
}
