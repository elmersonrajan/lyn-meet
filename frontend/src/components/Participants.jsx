import React from "react";
import { IconMic, IconMicOff, IconUserMinus, IconUsers, IconHand } from "./Icons.jsx";

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

/**
 * Raised hands float to the top in the order they went up, so staff answer
 * whoever asked first. Everyone else keeps arrival order (Array.sort is stable).
 */
export function sortByHand(list) {
  return [...list].sort((a, b) => {
    if (Boolean(a.handRaised) !== Boolean(b.handRaised)) return a.handRaised ? -1 : 1;
    if (a.handRaised && b.handRaised) return (a.handRaisedAt || 0) - (b.handRaisedAt || 0);
    return 0;
  });
}

export default function Participants({ list, canRemove, selfId, onRemove, onLowerHand }) {
  const ordered = sortByHand(list);
  const raised = ordered.filter((p) => p.handRaised).length;

  return (
    <div className="plist">
      <div className="side-head">
        <IconUsers size={15} />
        Participants ({list.length})
        {raised ? (
          <span className="hand-count" title={`${raised} hand(s) raised`}>
            <IconHand size={12} />
            {raised}
          </span>
        ) : null}
      </div>
      {ordered.map((p, i) => (
        <div className={`prow ${p.handRaised ? "hand" : ""}`} key={p.id}>
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

          {p.handRaised ? (
            <button
              type="button"
              className="hand-btn"
              title={
                canRemove || p.id === selfId
                  ? `Lower ${p.id === selfId ? "your" : `${p.name}'s`} hand`
                  : "Hand raised"
              }
              onClick={() => (canRemove || p.id === selfId ? onLowerHand?.(p.id) : undefined)}
              disabled={!canRemove && p.id !== selfId}
            >
              <span className="hand-order">{i + 1}</span>
              <IconHand size={15} />
            </button>
          ) : null}

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
