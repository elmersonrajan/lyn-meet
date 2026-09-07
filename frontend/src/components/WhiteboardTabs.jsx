import React, { useEffect, useRef } from "react";

/**
 * The row of boards along the top of the whiteboard.
 *
 * A new board used to replace the one before it, so a teacher who wanted a
 * clean page had to choose between keeping the working and having room to
 * write. Now each board stays for the meeting and these are the way back to it.
 *
 * Only the teacher can switch, and switching moves the whole class -- a tab
 * that changed the teacher's view alone would leave forty people looking at
 * work that had silently moved on.
 */
export default function WhiteboardTabs({
  boards,
  activeId,
  canEdit,
  onSelect,
  onAdd,
  onRemove,
  busy,
}) {
  if (!boards || boards.length === 0) return null;

  // The last board cannot be closed: a meeting with no whiteboard would show
  // an empty stage with no way back to one.
  const canClose = canEdit && boards.length > 1;

  /**
   * Past a handful of boards, only the live one keeps its full name.
   *
   * Ten tabs reading "Whiteboard 10" cannot fit a row and cannot usefully
   * shrink either -- every one of them would be truncated to "Whitebo…" and
   * the row would be ten identical smudges. The number is the part that
   * identifies a board, so beyond five that is all the others show, with the
   * full name still on hover. Chrome does the same thing: the tab you are on
   * stays legible and the rest give way.
   */
  const compact = boards.length > 5;

  const activeRef = useRef(null);

  useEffect(() => {
    // A board can be created or switched to while off-screen -- by this
    // teacher pressing +, or by nobody at all after a reconnect. The bar
    // scrolls to whatever is live rather than leaving them to find it.
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, boards.length]);

  return (
    <div className="board-tabs" role="tablist" aria-label="Whiteboards">
      {boards.map((board, index) => {
        const active = board.id === activeId;
        const name = board.name || `Whiteboard ${index + 1}`;
        return (
          <span
            key={board.id}
            ref={active ? activeRef : null}
            className={`board-tab-wrap ${active ? "active" : ""} ${
              compact && !active ? "compact" : ""
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className={`board-tab ${active ? "active" : ""} ${canClose ? "closable" : ""}`}
              // Students see which board the class is on, but the tabs are not
              // theirs to press.
              disabled={!canEdit || busy}
              onClick={() => onSelect(board.id)}
              title={canEdit ? `Switch everyone to ${name}` : name}
            >
              <span className="board-tab-name">
                {compact && !active ? index + 1 : name}
              </span>
              {board.strokeCount ? <span className="board-tab-dot" aria-hidden="true" /> : null}
            </button>
            {canClose ? (
              <button
                type="button"
                className="board-tab-close"
                // Without this the click reaches the tab underneath and the
                // class is moved to the board being deleted on its way out.
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove?.(board.id, name);
                }}
                disabled={busy}
                title={`Delete ${name}`}
                aria-label={`Delete ${name}`}
              >
                ×
              </button>
            ) : null}
          </span>
        );
      })}
      {canEdit ? (
        <button
          type="button"
          className="board-tab add"
          onClick={onAdd}
          disabled={busy}
          title="New whiteboard — the current one is kept"
          aria-label="New whiteboard"
        >
          +
        </button>
      ) : null}
    </div>
  );
}
