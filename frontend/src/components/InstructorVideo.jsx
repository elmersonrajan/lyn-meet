import React, { useEffect, useRef } from "react";

/**
 * The instructor tile — the teacher's own camera for the teacher, and the
 * teacher's camera as received for everyone else.
 *
 * The picture is mirrored for everyone, which is what was asked for. It began as
 * the teacher's self-view only, since an un-mirrored self-view is disconcerting
 * — you raise your right hand and the screen raises its left — but the class
 * sees the same flip now.
 *
 * The trade that comes with that: writing or a book held up to the camera reads
 * backwards for the class. Worth remembering if anyone reports text on screen
 * being reversed, because this is why.
 *
 * Presentation only. What is published to the class is untouched, and the
 * recording is composed on the server from the RTP and never sees this
 * stylesheet — so recordings are still the true way round.
 */
export default function InstructorVideo({ stream, name, disconnected, muted }) {
  const ref = useRef(null);

  useEffect(() => {
    try {
      if (ref.current) {
        ref.current.srcObject = stream || null;
        ref.current.muted = Boolean(muted);
        const play = () => ref.current?.play().catch((err) => console.warn("[InstructorVideo] play", err));
        play();
      }
    } catch (err) {
      console.error("[InstructorVideo] attach failed", err);
    }
  }, [stream, muted]);

  return (
    <div className="instructor-wrap">
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
