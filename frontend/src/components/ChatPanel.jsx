import React, { useEffect, useRef } from "react";
import { PollCard, PollComposer } from "./Poll.jsx";
import { QuestionCard, QuestionComposer } from "./QandA.jsx";
import { IconChat, IconClose, IconPoll } from "./Icons.jsx";

export default function ChatPanel({
  open,
  tab,
  onTab,
  onClose,
  questions,
  polls,
  myVotes,
  isStaff,
  onVoted,
  onAnswered,
  onError,
}) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, tab, questions.length, polls.length]);

  if (!open) return null;

  const ordered = [...polls].sort((a, b) => b.createdAt - a.createdAt);
  // Newest question first: it is the one being answered right now.
  const orderedQuestions = [...questions].sort((a, b) => b.at - a.at);

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
            Q&amp;A
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
          orderedQuestions.length ? (
            orderedQuestions.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                isStaff={isStaff}
                onError={onError}
                onAnswered={onAnswered}
              />
            ))
          ) : (
            <p className="dock-empty">
              {isStaff
                ? "Ask the class a question below. Their answers come back to you and the coordinator only."
                : "No questions yet — the teacher will ask one."}
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
          <QuestionComposer onError={onError} onPosted={() => onTab("chat")} />
        ) : (
          <PollComposer onError={onError} onPosted={() => onTab("poll")} />
        )
      ) : tab === "poll" ? (
        <p className="dock-readonly">You can vote on polls.</p>
      ) : null}
    </aside>
  );
}
