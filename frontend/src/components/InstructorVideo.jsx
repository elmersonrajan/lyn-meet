import React, { useEffect, useRef } from "react";

/**
 * The instructor tile — the teacher's own camera for the teacher, and the
 * teacher's camera as received for everyone else.
 *
 * `mirror` flips it horizontally, and is only ever set for the person whose own
 * camera it is. Seeing yourself un-mirrored is disconcerting: raising your right
 * hand appears to raise the left, so every self-view in every conferencing app
 * is flipped. It must not apply to anyone else's view of the teacher — the class
 * would then see any writing or book held up to the camera reversed. Nor does it
 * touch the recording, which is composed on the server from the RTP and never
 * sees this stylesheet.
 */
export default function InstructorVideo({ stream, name, disconnected, muted, mirror }) {
  const ref = useRef(null);

  /**
   * A stream is not the same thing as a picture.
   *
   * Turning the camera off stops the track and hands the device back, which
   * leaves the teacher holding a stream that still carries their microphone
   * and nothing else. Rendering a <video> for that shows a black rectangle,
   * which reads as a fault rather than as a camera that is off.
   */
  /**
   * A dropped connection is not a picture either, whatever the track says.
   *
   * WebRTC does not end a receiving track when the sender's signalling dies --
   * frames simply stop arriving, and the <video> goes on displaying the last
   * one it decoded. So a teacher whose laptop shut sat there apparently
   * present, and "Teacher reconnecting…" was unreachable because it was only
   * offered when there was no picture at all. The frozen frame is the least
   * true of the three things this tile can show, so it loses to both.
   */
  const hasPicture = Boolean(
    !disconnected && stream && stream.getVideoTracks().some((track) => track.readyState === "live"),
  );

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
  }, [stream, muted, hasPicture]);

  return (
    <div className="instructor-wrap">
      <div className="side-head">Instructor Video</div>
      <div className="instructor">
        {hasPicture ? (
          <video
            ref={ref}
            className={mirror ? "mirrored" : ""}
            autoPlay
            playsInline
            muted={Boolean(muted)}
          />
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
