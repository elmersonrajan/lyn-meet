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

const RANK = { teacher: 0, coordinator: 1 };

/**
 * Orders the list so the people you need are where you expect them.
 *
 * Staff are pinned at the top, because who is running the class does not change
 * with who happens to be talking. Below them come whoever is speaking, so a
 * class of forty does not leave you hunting for the voice you can hear. Raised
 * hands come next, still in the order they went up, so the queue is preserved.
 * Everyone else keeps arrival order — Array.sort is stable, so equal ranks stay
 * as they were.
 *
 * @param {Array} list
 * @param {string[]} speaking peer ids, loudest first
 */
export function sortParticipants(list, speaking = []) {
  const speakingRank = new Map(speaking.map((id, i) => [id, i]));

  const groupOf = (p) => {
    if (RANK[p.role] != null) return RANK[p.role];
    if (speakingRank.has(p.id)) return 2;
    if (p.handRaised) return 3;
    return 4;
  };

  return [...list].sort((a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga !== gb) return ga - gb;
    if (ga === 2) return speakingRank.get(a.id) - speakingRank.get(b.id);
    if (ga === 3) return (a.handRaisedAt || 0) - (b.handRaisedAt || 0);
    return 0;
  });
}

/** Three bars that rise and fall, so "talking" reads at a glance. */
function SpeakingBars() {
  return (
    <span className="speak-bars" role="img" aria-label="speaking">
      <i />
      <i />
      <i />
    </span>
  );
}

export default function Participants({
  list,
  canRemove,
  selfId,
  speaking = [],
  onRemove,
  onLowerHand,
}) {
  const speakingSet = new Set(speaking);
  const ordered = sortParticipants(list, speaking);
  const raised = ordered.filter((p) => p.handRaised).length;

  // The queue is by when the hand went up, independent of where the row sits.
  const handOrder = new Map(
    list
      .filter((p) => p.handRaised)
      .sort((a, b) => (a.handRaisedAt || 0) - (b.handRaisedAt || 0))
      .map((p, i) => [p.id, i + 1]),
  );

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
      {ordered.map((p) => {
        const isSpeaking = speakingSet.has(p.id) && !p.disconnected;
        return (
        <div
          className={`prow ${p.handRaised ? "hand" : ""} ${isSpeaking ? "speaking" : ""}`}
          key={p.id}
        >
          <div className={`avatar ${p.role}`}>{initials(p.name)}</div>
          <div className="pinfo">
            <div className="pname">
              {p.name}
              {isSpeaking ? <SpeakingBars /> : null}
              {p.id === selfId ? <span className="pself">you</span> : null}
              {ROLE_LABEL[p.role] ? (
                <span className={`role-tag ${p.role}`}>{ROLE_LABEL[p.role]}</span>
              ) : null}
            </div>
            <div className="pstatus">
              {p.disconnected ? (
                "reconnecting…"
              ) : isSpeaking ? (
                <>
                  <IconMic size={12} />
                  speaking
                </>
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
              {/* Position in the hand queue, which is not the row number:
                  someone speaking is lifted above the queue. */}
              <span className="hand-order">{handOrder.get(p.id)}</span>
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
        );
      })}
    </div>
  );
}
