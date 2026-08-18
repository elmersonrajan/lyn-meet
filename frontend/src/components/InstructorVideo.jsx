import React, { useEffect, useRef } from "react";

export default function InstructorVideo({ stream, name, disconnected }) {
  const ref = useRef(null);

  useEffect(() => {
    try {
      if (ref.current) ref.current.srcObject = stream || null;
    } catch (err) {
      console.error("[InstructorVideo] attach failed", err);
    }
  }, [stream]);

  return (
    <div>
      <div className="side-head">Instructor Video</div>
      <div className="instructor">
        {stream ? (
          <video ref={ref} autoPlay playsInline muted={false} />
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
