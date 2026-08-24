import React from "react";

export default function Toolbar({
  isTeacher,
  isCoordinator,
  camOn,
  micOn,
  recording,
  onToggleCam,
  onToggleMic,
  onMuteOthers,
  onToggleRecord,
  onCloseSession,
  onPostQa,
  onPostMsg,
  onLeave,
}) {
  const staff = isTeacher || isCoordinator;
  return (
    <div className="toolbar">
      {isTeacher ? (
        <>
          <button className="tbtn" onClick={onToggleCam}>
            <span className="ico">{camOn ? "📹" : "🚫"}</span>
            {camOn ? "Video On" : "Video Off"}
          </button>
          <button className="tbtn" onClick={onToggleCam}>
            <span className="ico">⏸</span>
            Pause Video
          </button>
        </>
      ) : null}

      <button className="tbtn" onClick={onToggleMic}>
        <span className="ico">{micOn ? "🎤" : "🔇"}</span>
        {micOn ? "Mute Mic" : "Unmute Mic"}
      </button>

      {staff ? (
        <>
          <button className="tbtn" onClick={onMuteOthers}>
            <span className="ico">👥</span>
            Mute Others
          </button>
          <button className="tbtn" onClick={onCloseSession}>
            <span className="ico">⎋</span>
            Close Session
          </button>
        </>
      ) : null}

      {staff ? (
        <button className={`tbtn ${recording ? "live" : ""}`} onClick={onToggleRecord}>
          <span className="ico" style={{ color: "#d32f2f" }}>
            ●
          </span>
          {recording ? "Stop Record" : "Start Record"}
        </button>
      ) : null}

      <button className="tbtn" onClick={onPostQa}>
        <span className="ico">❓</span>
        Post a QA
      </button>
      <button className="tbtn" onClick={onPostMsg}>
        <span className="ico">💬</span>
        Post Msg
      </button>
      <button className="tbtn danger" onClick={onLeave}>
        <span className="ico">➜</span>
        Leave Session
      </button>
    </div>
  );
}
