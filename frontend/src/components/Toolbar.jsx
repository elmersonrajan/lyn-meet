import React from "react";

export default function Toolbar({
  isTeacher,
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
  return (
    <div className="toolbar">
      <button className="tbtn" disabled={!isTeacher} onClick={onToggleCam} title="Students cannot enable camera">
        <span className="ico">{camOn && isTeacher ? "📹" : "🚫"}</span>
        Video Off
      </button>
      <button className="tbtn" disabled={!isTeacher} onClick={onToggleCam}>
        <span className="ico">⏸</span>
        Pause Video
      </button>
      <button className="tbtn" onClick={onToggleMic}>
        <span className="ico">{micOn ? "🎤" : "🔇"}</span>
        Mute Mic
      </button>
      <button className="tbtn" disabled={!isTeacher} onClick={onMuteOthers}>
        <span className="ico">👥</span>
        Mute Others
      </button>
      <button
        className={`tbtn ${recording ? "live" : ""}`}
        disabled={!isTeacher}
        onClick={onToggleRecord}
      >
        <span className="ico" style={{ color: "#d32f2f" }}>●</span>
        {recording ? "Stop Record" : "Start Record"}
      </button>
      <button className="tbtn" disabled={!isTeacher} onClick={onCloseSession}>
        <span className="ico">⎋</span>
        Close Session
      </button>
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
