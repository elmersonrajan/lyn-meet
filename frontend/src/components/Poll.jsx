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
  // Any number of options can be the answer, so this is a set, not an index.
  const [correct, setCorrect] = useState([0]);
  const [minutes, setMinutes] = useState(2);
  const [busy, setBusy] = useState(false);

  const toggleCorrect = (i) =>
    setCorrect((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort()));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!correct.length) {
      onError?.("Mark at least one correct option");
      return;
    }
    setBusy(true);
    try {
      await emitAck("create-poll", {
        question,
        options,
        correct,
        durationMs: minutes * 60 * 1000,
      });
      setQuestion("");
      setOptions(EMPTY);
      setCorrect([0]);
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

      <label className="poll-label">
        Options — tick every correct one
        <span className="poll-hint">
          {correct.length > 1 ? `${correct.length} correct answers` : "1 correct answer"}
        </span>
      </label>
      {options.map((opt, i) => (
        <div key={i} className={`poll-opt-row ${correct.includes(i) ? "correct" : ""}`}>
          <button
            type="button"
            className="poll-radio"
            onClick={() => toggleCorrect(i)}
            title="Mark as a correct answer"
            aria-pressed={correct.includes(i)}
          >
            {correct.includes(i) ? <IconCheck size={14} /> : LETTERS[i]}
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
  // What this person has ticked but not yet sent.
  const [picked, setPicked] = useState([]);
  const mine = Array.isArray(myVote) ? myVote : myVote != null ? [myVote] : null;
  const voted = Boolean(mine);
  const expired = poll.closed || left <= 0;
  const maxCount = poll.closed ? Math.max(1, ...(poll.counts || [1])) : 1;
  const correct = poll.correct || [];

  const toggle = (index) => {
    if (busy || voted || expired || !canVote) return;
    setPicked((prev) =>
      prev.includes(index) ? prev.filter((x) => x !== index) : [...prev, index].sort(),
    );
  };

  const submit = async () => {
    if (busy || voted || expired || !picked.length) return;
    setBusy(true);
    try {
      await emitAck("vote-poll", { pollId: poll.id, optionIndexes: picked });
      onVoted?.(poll.id, picked);
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
          const isCorrect = poll.closed && correct.includes(i);
          const isMine = voted ? mine.includes(i) : picked.includes(i);

          return (
            <li key={i}>
              <button
                type="button"
                className={`poll-option ${isCorrect ? "correct" : ""} ${isMine ? "mine" : ""}`}
                onClick={() => toggle(i)}
                disabled={!canVote || voted || expired || busy}
              >
                <span className="poll-letter">
                  {isCorrect || (isMine && !poll.closed) ? <IconCheck size={14} /> : LETTERS[i]}
                </span>
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
        {poll.closed && poll.correctVotes != null ? (
          <span className="poll-note">
            {poll.correctVotes} of {poll.totalVotes} fully correct
          </span>
        ) : null}
        {!poll.closed && voted ? <span className="poll-note">Answer recorded</span> : null}
        {/* Never says how many are correct: that would give the answer away. */}
        {!poll.closed && !voted && canVote ? (
          <span className="poll-note">Tick every answer you think is right</span>
        ) : null}
        {!poll.closed && !canVote ? (
          <span className="poll-note">{poll.totalVotes} voted so far</span>
        ) : null}
        {!poll.closed && !voted && canVote ? (
          <button
            type="button"
            className="poll-submit"
            onClick={submit}
            disabled={busy || !picked.length}
          >
            {busy ? "Sending…" : `Submit${picked.length > 1 ? ` (${picked.length})` : ""}`}
          </button>
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
