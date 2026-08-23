import React from "react";

function roleLabel(role) {
  if (role === "teacher") return "(Teacher)";
  if (role === "coordinator") return "(Coordinator)";
  return "";
}

export default function Participants({ list, canRemove, selfId, onRemove }) {
  return (
    <div className="plist">
      <div className="side-head">Participants ({list.length})</div>
      {list.map((p) => (
        <div className="prow" key={p.id}>
          <div className="avatar">👤</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>
              {p.name} {roleLabel(p.role)}
            </div>
            <div style={{ fontSize: 11, color: "#5b6b80" }}>
              {p.disconnected ? "reconnecting" : p.audioMuted ? "muted" : "in session"}
            </div>
          </div>
          {canRemove && p.id !== selfId ? (
            <button
              type="button"
              className="kick-btn"
              title="Remove participant"
              onClick={() => onRemove(p.id)}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
