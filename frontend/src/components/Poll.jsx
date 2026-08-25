import React, { useEffect, useState } from "react";
import { emitAck } from "../services/socket";
import { IconCheck, IconClock, IconPoll, IconSend, IconUsers } from "./Icons.jsx";

const LETTERS = ["A", "B", "C", "D"];
const EMPTY = ["", "", "", ""];

function useCountdown(endsAt, closed) {
  const [left, setLeft] = useState(() => Math.max(0, endsAt - Date.now()));

  useEffect(() => {
    if (closed) return undefined;
    const tick = () => setLeft(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [endsAt, closed]);

  return left;
}

function clock(ms) {
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function PollComposer({ onError, onPosted }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(EMPTY);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [minutes, setMinutes] = useState(2);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await emitAck("create-poll", {
        question,
        options,
        correctIndex,
        durationMs: minutes * 60 * 1000,
      });
      setQuestion("");
      setOptions(EMPTY);
      setCorrectIndex(0);
      onPosted?.();
    } catch (err) {
      console.error("[Poll] create failed", err);
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="poll-composer" onSubmit={submit}>
      <label className="poll-label">Question</label>
      <input
        className="poll-input"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="e.g. Which layer handles ICE negotiation?"
        maxLength={500}
      />

      <label className="poll-label">Options — tick the correct one</label>
      {options.map((opt, i) => (
        <div key={i} className={`poll-opt-row ${correctIndex === i ? "correct" : ""}`}>
          <button
            type="button"
            className="poll-radio"
            onClick={() => setCorrectIndex(i)}
            title="Mark as the correct answer"
            aria-pressed={correctIndex === i}
          >
            {correctIndex === i ? <IconCheck size={14} /> : LETTERS[i]}
          </button>
          <input
            className="poll-input"
            value={opt}
            onChange={(e) => {
              const next = [...options];
              next[i] = e.target.value;
              setOptions(next);
            }}
            placeholder={`Option ${LETTERS[i]}`}
            maxLength={200}
          />
        </div>
      ))}

      <div className="poll-foot">
        <label className="poll-duration">
          <IconClock size={16} />
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            <option value={1}>1 min</option>
            <option value={2}>2 min</option>
            <option value={5}>5 min</option>
          </select>
        </label>
        <button type="submit" className="poll-launch" disabled={busy}>
          <IconSend size={16} />
          {busy ? "Launching…" : "Launch Poll"}
        </button>
      </div>
    </form>
  );
}

export function PollCard({ poll, myVote, canVote, canEnd, onVoted, onError }) {
  const left = useCountdown(poll.endsAt, poll.closed);
  const [busy, setBusy] = useState(false);
  const voted = myVote != null;
  const expired = poll.closed || left <= 0;
  const maxCount = poll.closed ? Math.max(1, ...(poll.counts || [1])) : 1;

  const vote = async (index) => {
    if (busy || voted || expired) return;
    setBusy(true);
    try {
      await emitAck("vote-poll", { pollId: poll.id, optionIndex: index });
      onVoted?.(poll.id, index);
    } catch (err) {
      console.error("[Poll] vote failed", err);
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    try {
      await emitAck("end-poll", { pollId: poll.id });
    } catch (err) {
      console.error("[Poll] end failed", err);
      onError?.(err.message);
    }
  };

  return (
    <article className={`poll-card ${poll.closed ? "closed" : "live"}`}>
      <header className="poll-card-head">
        <span className={`poll-chip ${poll.closed ? "" : "live"}`}>
          <IconPoll size={13} />
          {poll.closed ? "Results" : "Live"}
        </span>
        {poll.closed ? (
          <span className="poll-meta">
            <IconUsers size={13} />
            {poll.totalVotes} voted
          </span>
        ) : (
          <span className="poll-meta">
            <IconClock size={13} />
            {clock(left)}
          </span>
        )}
      </header>

      <h4 className="poll-question">{poll.question}</h4>

      <ul className="poll-options">
        {poll.options.map((opt, i) => {
          const count = poll.counts?.[i] ?? 0;
          const pct = poll.totalVotes ? Math.round((count / poll.totalVotes) * 100) : 0;
          const isCorrect = poll.closed && poll.correctIndex === i;
          const isMine = myVote === i;

          return (
            <li key={i}>
              <button
                type="button"
                className={`poll-option ${isCorrect ? "correct" : ""} ${isMine ? "mine" : ""}`}
                onClick={() => vote(i)}
                disabled={!canVote || voted || expired || busy}
              >
                <span className="poll-letter">{isCorrect ? <IconCheck size={14} /> : LETTERS[i]}</span>
                <span className="poll-text">{opt}</span>
                {poll.closed ? (
                  <span className="poll-count">
                    {count} · {pct}%
                  </span>
                ) : null}
                {poll.closed ? (
                  <span
                    className="poll-bar"
                    style={{ width: `${Math.round((count / maxCount) * 100)}%` }}
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <footer className="poll-card-foot">
        <span className="poll-by">by {poll.from}</span>
        {!poll.closed && voted ? <span className="poll-note">Vote recorded</span> : null}
        {!poll.closed && !voted && canVote ? <span className="poll-note">Pick one answer</span> : null}
        {!poll.closed && !canVote ? (
          <span className="poll-note">{poll.totalVotes} voted so far</span>
        ) : null}
        {!poll.closed && canEnd ? (
          <button type="button" className="poll-end" onClick={end}>
            Reveal now
          </button>
        ) : null}
      </footer>
    </article>
  );
}
