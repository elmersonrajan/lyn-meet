import React, { useState } from "react";
import { emitAck } from "../services/socket";
import { IconCheck, IconSend, IconUsers } from "./Icons.jsx";

function timeOf(at) {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Staff put a question to the class. */
export function QuestionComposer({ onError, onPosted }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await emitAck("ask-question", { text });
      setText("");
      onPosted?.();
    } catch (err) {
      console.error("[QandA] ask failed", err);
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="qa-composer" onSubmit={submit}>
      <textarea
        className="qa-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask the class a question…"
        maxLength={2000}
        rows={2}
      />
      <button type="submit" className="qa-ask" disabled={busy || !text.trim()}>
        <IconSend size={16} />
        {busy ? "Asking…" : "Ask"}
      </button>
    </form>
  );
}

/** The box a student types their answer into. */
function AnswerForm({ question, onError, onAnswered }) {
  const [text, setText] = useState(question.myAnswer?.text || "");
  const [busy, setBusy] = useState(false);
  const answered = Boolean(question.myAnswer);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      const res = await emitAck("answer-question", { questionId: question.id, text });
      onAnswered?.(question.id, res.answer);
    } catch (err) {
      console.error("[QandA] answer failed", err);
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (question.closed) {
    return answered ? (
      <p className="qa-mine">
        <IconCheck size={13} />
        Your answer: {question.myAnswer.text}
      </p>
    ) : (
      <p className="qa-note">Closed — you did not answer this one.</p>
    );
  }

  return (
    <form className="qa-answer-form" onSubmit={submit}>
      <textarea
        className="qa-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write your answer…"
        maxLength={2000}
        rows={2}
      />
      <div className="qa-answer-foot">
        {/* Said plainly, because it changes how freely people answer. */}
        <span className="qa-note">Only the teacher and coordinator can see this.</span>
        <button type="submit" className="qa-send" disabled={busy || !text.trim()}>
          <IconSend size={14} />
          {busy ? "Sending…" : answered ? "Update" : "Answer"}
        </button>
      </div>
    </form>
  );
}

/**
 * One question and, for staff only, everything the class wrote back.
 *
 * A student sees the question, how many people have answered, and their own
 * answer. They never receive anyone else's — the server does not send them, so
 * there is nothing here to hide.
 */
export function QuestionCard({ question, isStaff, onError, onAnswered }) {
  const answers = question.answers || [];

  return (
    <article className={`qa-card ${question.closed ? "closed" : "open"}`}>
      <header className="qa-card-head">
        <div className="meta">
          <strong>{question.from}</strong>
          <span className={`role-tag ${question.role}`}>{question.role}</span>
          <span className="msg-time">{timeOf(question.at)}</span>
        </div>
        <span className="qa-count" title={`${question.answerCount} answered`}>
          <IconUsers size={13} />
          {question.answerCount}
        </span>
      </header>

      <p className="qa-question">{question.text}</p>

      {isStaff ? (
        <>
          {answers.length ? (
            <ul className="qa-answers">
              {answers.map((a) => (
                <li key={a.id} className="qa-answer">
                  <span className="qa-answer-who">{a.name}</span>
                  <span className="qa-answer-text">{a.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="qa-note">No answers yet.</p>
          )}
          {!question.closed ? (
            <button
              type="button"
              className="qa-close"
              onClick={async () => {
                try {
                  await emitAck("close-question", { questionId: question.id });
                } catch (err) {
                  onError?.(err.message);
                }
              }}
            >
              Stop accepting answers
            </button>
          ) : (
            <p className="qa-note">Closed.</p>
          )}
        </>
      ) : (
        <AnswerForm question={question} onError={onError} onAnswered={onAnswered} />
      )}
    </article>
  );
}
