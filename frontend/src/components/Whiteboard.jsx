import React from "react";
import { IconPen, IconEraser, IconTrash } from "./Icons.jsx";

const COLORS = ["#163a6b", "#d32f2f", "#1b8a4a", "#e08600", "#111827"];

export default function Whiteboard({ board }) {
  const erasing = board.tool === "eraser";
  const [dragging, setDragging] = React.useState(false);

  /**
   * A picture can arrive by being dropped on the board as well as by Ctrl+V.
   * Both end in the same place; dropping is simply what somebody does with a
   * file they have in a folder rather than on a clipboard.
   */
  const onDragOver = (e) => {
    if (!board.allowed) return;
    e.preventDefault();
    setDragging(true);
  };

  return (
    <div
      className={`board-drop ${dragging ? "over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!board.allowed) return;
        e.preventDefault();
        setDragging(false);
        board.onDropFiles?.(e.dataTransfer);
      }}
    >
      <canvas
        ref={board.canvasRef}
        onMouseDown={board.onDown}
        onMouseMove={board.onMove}
        onMouseUp={board.onUp}
        onMouseLeave={board.onUp}
        onTouchStart={board.onDown}
        onTouchMove={board.onMove}
        onTouchEnd={board.onUp}
        style={{
          cursor: board.allowed ? (erasing ? "cell" : "crosshair") : "default",
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
        }}
      />

      {board.allowed ? (
        <div className="board-tools" role="toolbar" aria-label="Whiteboard tools">
          <button
            type="button"
            className={`board-tool ${!erasing ? "active" : ""}`}
            onClick={() => board.setTool("pen")}
            title="Pen"
            aria-pressed={!erasing}
          >
            <IconPen size={18} />
          </button>
          <button
            type="button"
            className={`board-tool ${erasing ? "active" : ""}`}
            onClick={() => board.setTool("eraser")}
            title="Eraser"
            aria-pressed={erasing}
          >
            <IconEraser size={18} />
          </button>

          <span className="board-sep" />

          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`board-swatch ${!erasing && board.color === c ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => {
                board.setColor(c);
                board.setTool("pen");
              }}
              title={`Pen colour ${c}`}
              aria-label={`Pen colour ${c}`}
            />
          ))}

          <span className="board-sep" />

          <button
            type="button"
            className="board-tool danger"
            onClick={board.clear}
            title="Clear whiteboard"
          >
            <IconTrash size={18} />
          </button>
        </div>
      ) : null}

      {/* Only while something is on its way: a permanent instruction on the
          board would be another thing to read every lesson. */}
      {board.pasting ? <div className="board-busy">Sharing the picture…</div> : null}
      {dragging ? <div className="board-dropzone">Drop the picture onto the board</div> : null}
    </div>
  );
}
