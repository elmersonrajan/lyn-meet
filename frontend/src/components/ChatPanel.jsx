import React, { useState } from "react";
import { emitAck } from "../services/socket";

export default function ChatPanel({ open, onClose, messages, mode }) {
  const [text, setText] = useState("");

  if (!open) return null;

  const send = async (e) => {
    e.preventDefault();
    try {
      console.log("[Chat] send", { mode, text });
      await emitAck("post-message", { text, type: mode });
      setText("");
    } catch (err) {
      console.error("[Chat] send failed", err);
    }
  };

  return (
    <aside className="chat-dock">
      <header>
        <span>{mode === "qa" ? "Post a QA" : "Messages"}</span>
        <button type="button" onClick={onClose} style={{ background: "transparent", color: "#fff", border: 0, cursor: "pointer" }}>
          ✕
        </button>
      </header>
      <div className="chat-list">
        {messages
          .filter((m) => (mode === "qa" ? m.type === "qa" : true))
          .map((m) => (
            <div key={m.id} className={`msg ${m.type}`}>
              <div className="meta">
                {m.from} · {m.role} · {m.type === "qa" ? "QA" : "msg"}
              </div>
              <div>{m.text}</div>
            </div>
          ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === "qa" ? "Ask a question…" : "Type a message…"}
        />
        <button type="submit">Send</button>
      </form>
    </aside>
  );
}
