import React from "react";

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
export default function WhiteboardTabs({ boards, activeId, canEdit, onSelect, onAdd, busy }) {
  if (!boards || boards.length === 0) return null;

  return (
    <div className="board-tabs" role="tablist" aria-label="Whiteboards">
      {boards.map((board, index) => {
        const active = board.id === activeId;
        return (
          <button
            key={board.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`board-tab ${active ? "active" : ""}`}
            // Students see which board the class is on, but the tabs are not
            // theirs to press.
            disabled={!canEdit || busy}
            onClick={() => onSelect(board.id)}
            title={canEdit ? `Switch everyone to ${board.name}` : board.name}
          >
            <span className="board-tab-name">{board.name || `Whiteboard ${index + 1}`}</span>
            {board.strokeCount ? <span className="board-tab-dot" aria-hidden="true" /> : null}
          </button>
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
