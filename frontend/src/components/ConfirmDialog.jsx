import React, { useEffect, useRef } from "react";

/**
 * A question that has to be answered before something irreversible happens.
 *
 * Ending a session throws forty people out of a lesson, and it sat one click
 * away from Leave. There is no undo for it and no way to call the class back,
 * so it is worth the second it costs to ask.
 *
 * Cancel is the default: focus lands on it, Escape chooses it, and clicking
 * the backdrop chooses it. Somebody who opened this by accident should be able
 * to get out of it by doing almost anything.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);

  // Focus is taken once, when the dialog appears. Tied to onCancel as well, it
  // would be taken again on every re-render of a busy meeting -- pulling the
  // caret out of whatever the person was doing.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        // Only the backdrop itself, so a drag that ends outside the card does
        // not dismiss it.
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div className="confirm-card" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3 className="confirm-title">{title}</h3>
        {message ? <p className="confirm-message">{message}</p> : null}
        <div className="confirm-actions">
          <button type="button" className="btn ghost" ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
