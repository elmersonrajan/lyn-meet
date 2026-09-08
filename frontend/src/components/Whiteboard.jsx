import React from "react";
import { IconPen, IconEraser, IconTrash, IconDocument } from "./Icons.jsx";
import BoardMenu from "./BoardMenu.jsx";

const COLORS = ["#163a6b", "#d32f2f", "#1b8a4a", "#e08600", "#111827"];

export default function Whiteboard({ board, onPlayVideo, onYouTube }) {
  const erasing = board.tool === "eraser";
  const [dragging, setDragging] = React.useState(false);
  const [menuAt, setMenuAt] = React.useState(null);
  const imageInput = React.useRef(null);
  const docInput = React.useRef(null);

  /**
   * What a right-click offers. Each item goes to whatever actually works for
   * that kind of thing rather than pretending they are all the same: a picture
   * and a document are sent to the class, while a video is played by sharing
   * the tab it is in -- a lesson video is hundreds of megabytes and belongs on
   * a live stream, not in a message.
   */
  const menuItems = [
    {
      key: "paste",
      label: "Paste",
      hint: "Ctrl+V",
      onSelect: () => board.pasteFromClipboard?.(),
    },
    { key: "sep1", separator: true },
    { key: "image", label: "Picture…", onSelect: () => imageInput.current?.click() },
    { key: "doc", label: "PDF or Word document…", onSelect: () => docInput.current?.click() },
    ...(onPlayVideo
      ? [{ key: "video", label: "Video…", hint: "shares a tab", onSelect: onPlayVideo }]
      : []),
    ...(onYouTube ? [{ key: "yt", label: "YouTube…", onSelect: onYouTube }] : []),
    { key: "sep2", separator: true },
    {
      key: "clear",
      label: board.showing ? "Remove the page" : "Clear the board",
      danger: true,
      onSelect: board.clear,
    },
  ];

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
      onContextMenu={(e) => {
        // Students keep the browser's own menu: they have nothing to put on
        // the board, and taking it away would only cost them "save image as".
        if (!board.allowed) return;
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      <canvas
        ref={board.canvasRef}
        onMouseDown={(e) => {
          /**
           * A plain drag moves the page whenever this board is not also a
           * surface to draw on -- which is exactly when a page is up, and
           * exactly when somebody has zoomed in. On a writable board the pen
           * keeps the plain drag and Shift moves the page instead.
           */
          if (board.canPan && (!board.canInk || e.shiftKey)) {
            e.preventDefault();
            if (board.panFrom(e)) return;
          }
          board.onDown(e);
        }}
        onDoubleClick={(e) => {
          // The quickest way in and back out again: doubling to 200% where the
          // pointer is, and doubling back to the whole page.
          if (!board.allowed) return;
          const r = e.currentTarget.getBoundingClientRect();
          if ((board.view?.scale || 1) > 1) board.resetView();
          else
            board.zoomAt(2, {
              x: (e.clientX - r.left) / (r.width || 1),
              y: (e.clientY - r.top) / (r.height || 1),
            });
        }}
        onTouchStart={(e) => {
          // One finger moves a page that has been zoomed into; on a board that
          // can be drawn on, one finger still draws.
          if (board.canPan && !board.canInk && e.touches.length === 1) {
            if (board.panFrom(e.touches[0])) return;
          }
          board.onDown(e);
        }}
        onMouseMove={board.onMove}
        onMouseUp={board.onUp}
        onMouseLeave={board.onUp}
        onTouchMove={board.onMove}
        onTouchEnd={board.onUp}
        style={{
          /**
           * The cursor is the only place this is explained, so it has to be
           * right: a crosshair where ink will land, a hand where the page can
           * be dragged, and neither where nothing will happen.
           */
          cursor: board.canPan && !board.canInk
            ? "grab"
            : board.canInk
              ? erasing
                ? "cell"
                : "crosshair"
              : "default",
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
        }}
      />

      {board.allowed ? (
        <div className="board-tools" role="toolbar" aria-label="Whiteboard tools">
          {/* Drawing tools only while there is something to draw on. A board
              showing a picture or a document is showing it; Clear is the way
              back to a board that can be written on. */}
          {board.canInk ? (
            <>
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
            </>
          ) : null}

          {board.canInk
            ? COLORS.map((c) => (
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
              ))
            : null}
          {board.canInk ? <span className="board-sep" /> : null}

          <span className="board-sep" />

          {/* Zoom moves the whole class's view: a teacher magnifying a
              paragraph is pointing at it, and forty people still seeing the
              whole page have not been shown anything. */}
          <button
            type="button"
            className="board-tool"
            onClick={() => board.zoomAt?.(1 / 1.4)}
            disabled={(board.view?.scale || 1) <= 1}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="board-tool board-zoom-level"
            onClick={board.resetView}
            disabled={(board.view?.scale || 1) === 1}
            title="Back to the whole page"
          >
            {Math.round((board.view?.scale || 1) * 100)}%
          </button>
          <button
            type="button"
            className="board-tool"
            onClick={() => board.zoomAt?.(1.4)}
            disabled={(board.view?.scale || 1) >= 6}
            title="Zoom in — hold Ctrl and scroll to zoom where the pointer is"
            aria-label="Zoom in"
          >
            +
          </button>

          <span className="board-sep" />

          {/* A PDF or a Word document, which the server converts. Paste and
              drop do the same thing; this is for a file that is neither on the
              clipboard nor convenient to drag. */}
          <label className="board-tool" title="Open a PDF or Word document on the board">
            <IconDocument size={18} />
            <input
              type="file"
              accept=".pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.odp,application/pdf"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) board.sendDocument?.(file);
              }}
            />
          </label>

          <button
            type="button"
            className="board-tool danger"
            onClick={board.clear}
            title={board.showing ? "Remove it and write on the board" : "Clear whiteboard"}
          >
            <IconTrash size={18} />
          </button>
        </div>
      ) : null}

      {/* Only while a document is open, and only for whoever turns the pages.
          Everyone else follows. */}
      {board.document ? (
        <div className="board-pager">
          <span className="board-pager-name" title={board.document.name}>
            {board.document.name}
          </span>
          {board.allowed ? (
            <>
              <button
                type="button"
                onClick={() => board.setPage((board.document.page || 1) - 1)}
                disabled={(board.document.page || 1) <= 1}
                aria-label="Previous page"
              >
                ‹
              </button>
              <span className="board-pager-count">
                {board.document.page || 1}
                {board.pageCount ? ` / ${board.pageCount}` : ""}
              </span>
              <button
                type="button"
                onClick={() => board.setPage((board.document.page || 1) + 1)}
                disabled={Boolean(board.pageCount) && (board.document.page || 1) >= board.pageCount}
                aria-label="Next page"
              >
                ›
              </button>
            </>
          ) : (
            <span className="board-pager-count">
              Page {board.document.page || 1}
              {board.pageCount ? ` of ${board.pageCount}` : ""}
            </span>
          )}
        </div>
      ) : null}

      {/* Only while something is on its way: a permanent instruction on the
          board would be another thing to read every lesson. */}
      {board.allowed ? (
        <>
          <BoardMenu at={menuAt} onClose={() => setMenuAt(null)} items={menuItems} />
          {/* The pickers the menu opens. Hidden rather than rendered on demand,
              so a click has something to reach immediately. */}
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) board.sendImage?.(file);
            }}
          />
          <input
            ref={docInput}
            type="file"
            accept=".pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.odp,application/pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) board.sendDocument?.(file);
            }}
          />
        </>
      ) : null}

      {board.canPan && !board.canInk ? (
        <div className="board-pan-hint">Drag to move · double-click to fit</div>
      ) : null}

      {board.pasting ? <div className="board-busy">Sharing the picture…</div> : null}
      {dragging ? <div className="board-dropzone">Drop the picture onto the board</div> : null}
    </div>
  );
}
