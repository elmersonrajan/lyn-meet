import React, { useEffect, useRef, useState } from "react";
import { emitAck } from "../services/socket";
import { PollCard, PollComposer } from "./Poll.jsx";
import { IconChat, IconClose, IconPoll, IconSend } from "./Icons.jsx";

function timeOf(at) {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ChatPanel({
  open,
  tab,
  onTab,
  onClose,
  messages,
  polls,
  myVotes,
  isStaff,
  onVoted,
  onError,
}) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, tab, messages.length, polls.length]);

  if (!open) return null;

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await emitAck("post-message", { text, type: "chat" });
      setText("");
    } catch (err) {
      console.error("[Chat] send failed", err);
      onError?.(err.message);
    }
  };

  const ordered = [...polls].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <aside className="chat-dock">
      <header className="dock-head">
        <div className="dock-tabs">
          <button
            type="button"
            className={tab === "chat" ? "active" : ""}
            onClick={() => onTab("chat")}
          >
            <IconChat size={15} />
            {isStaff ? "Announce" : "Messages"}
          </button>
          <button
            type="button"
            className={tab === "poll" ? "active" : ""}
            onClick={() => onTab("poll")}
          >
            <IconPoll size={15} />
            Polls
          </button>
        </div>
        <button type="button" className="dock-close" onClick={onClose} aria-label="Close panel">
          <IconClose size={16} />
        </button>
      </header>

      <div className="chat-list" ref={listRef}>
        {tab === "chat" ? (
          messages.length ? (
            messages.map((m) => (
              <div key={m.id} className="msg">
                <div className="meta">
                  <strong>{m.from}</strong>
                  <span className={`role-tag ${m.role}`}>{m.role}</span>
                  <span className="msg-time">{timeOf(m.at)}</span>
                </div>
                <div className="msg-body">{m.text}</div>
              </div>
            ))
          ) : (
            <p className="dock-empty">
              No announcements yet. Only the teacher or coordinator can post here.
            </p>
          )
        ) : ordered.length ? (
          ordered.map((p) => (
            <PollCard
              key={p.id}
              poll={p}
              myVote={myVotes[p.id]}
              canVote={!isStaff}
              canEnd={isStaff}
              onVoted={onVoted}
              onError={onError}
            />
          ))
        ) : (
          <p className="dock-empty">
            {isStaff ? "Launch a poll below." : "No polls yet — the teacher will post one."}
          </p>
        )}
      </div>

      {isStaff ? (
        tab === "chat" ? (
          <form className="chat-form" onSubmit={send}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Message the class…"
              maxLength={2000}
            />
            <button type="submit" aria-label="Send">
              <IconSend size={16} />
            </button>
          </form>
        ) : (
          <PollComposer onError={onError} onPosted={() => onTab("poll")} />
        )
      ) : (
        <p className="dock-readonly">
          {tab === "chat" ? "View only — messages come from teaching staff." : "You can vote on polls."}
        </p>
      )}
    </aside>
  );
}
