import React from "react";
import { IconMic, IconMicOff, IconUserMinus, IconUsers } from "./Icons.jsx";

const ROLE_LABEL = { teacher: "Teacher", coordinator: "Coordinator" };

function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export default function Participants({ list, canRemove, selfId, onRemove }) {
  return (
    <div className="plist">
      <div className="side-head">
        <IconUsers size={15} />
        Participants ({list.length})
      </div>
      {list.map((p) => (
        <div className="prow" key={p.id}>
          <div className={`avatar ${p.role}`}>{initials(p.name)}</div>
          <div className="pinfo">
            <div className="pname">
              {p.name}
              {p.id === selfId ? <span className="pself">you</span> : null}
              {ROLE_LABEL[p.role] ? (
                <span className={`role-tag ${p.role}`}>{ROLE_LABEL[p.role]}</span>
              ) : null}
            </div>
            <div className="pstatus">
              {p.disconnected ? (
                "reconnecting…"
              ) : (
                <>
                  {p.audioMuted ? <IconMicOff size={12} /> : <IconMic size={12} />}
                  {p.audioMuted ? "muted" : "in session"}
                </>
              )}
            </div>
          </div>
          {canRemove && p.id !== selfId ? (
            <button
              type="button"
              className="kick-btn"
              title={`Remove ${p.name}`}
              aria-label={`Remove ${p.name}`}
              onClick={() => onRemove(p.id)}
            >
              <IconUserMinus size={14} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
