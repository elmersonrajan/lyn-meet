import React from "react";

export default function Participants({ list }) {
  return (
    <div className="plist">
      <div className="side-head">Participants ({list.length})</div>
      {list.map((p) => (
        <div className="prow" key={p.id}>
          <div className="avatar">👤</div>
          <div>
            <div>
              {p.name} {p.role === "teacher" ? "(Teacher)" : ""}
            </div>
            <div style={{ fontSize: 11, color: "#5b6b80" }}>
              {p.disconnected ? "reconnecting" : p.audioMuted ? "muted" : "in session"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
