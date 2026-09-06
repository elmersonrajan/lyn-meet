import React, { useEffect, useRef, useState } from "react";

/**
 * Where a teacher pastes the link to a video for the class.
 *
 * A browser prompt would have done the job, but it is the one piece of UI in
 * the meeting that cannot say why a link was refused -- and the whole class is
 * waiting while the teacher works it out. This validates as they type, so the
 * Play button is only live when the link is one that will actually work.
 *
 * The check here is a courtesy, not a gate. The server resolves the link again
 * and refuses anything it does not recognise; nothing on this side decides what
 * reaches forty screens.
 */

/** The same shapes the server accepts, kept simple: this only enables a button. */
const LOOKS_LIKE_YOUTUBE =
  /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com\/(watch\?[^ ]*v=|embed\/|shorts\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/;
const BARE_ID = /^[A-Za-z0-9_-]{11}$/;

export function looksLikeYouTube(value) {
  const text = String(value || "").trim();
  return BARE_ID.test(text) || LOOKS_LIKE_YOUTUBE.test(text);
}

export default function YouTubeDialog({ open, busy, error, onPlay, onCancel }) {
  const [url, setUrl] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setUrl("");
    // Focused so a teacher can paste and press Enter without reaching for the
    // mouse, which is the whole interaction most of the time.
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const valid = looksLikeYouTube(url);
  const submit = (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    onPlay(url.trim());
  };

  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <form className="confirm-card" onSubmit={submit} aria-label="Play a YouTube video">
        <h3 className="confirm-title">Play a YouTube video</h3>
        <p className="confirm-message">
          Everyone in the meeting watches this together, with sound. You control play, pause and
          position.
        </p>
        <input
          ref={inputRef}
          className="yt-input"
          type="url"
          inputMode="url"
          placeholder="https://www.youtube.com/watch?v=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        {/* Nothing at all until they have typed something: a validation error
            on an empty box is a telling-off for not having started yet. */}
        {url && !valid ? (
          <div className="yt-hint bad">That is not a YouTube video link</div>
        ) : null}
        {error ? <div className="yt-hint bad">{error}</div> : null}
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {busy ? "Starting…" : "Play for everyone"}
          </button>
        </div>
      </form>
    </div>
  );
}
