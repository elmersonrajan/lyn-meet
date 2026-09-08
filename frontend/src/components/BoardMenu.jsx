import React, { useEffect, useRef } from "react";

/**
 * The right-click menu on the whiteboard.
 *
 * Ctrl+V and dropping a file already work, and neither is discoverable: a
 * teacher has to be told they exist. Right-clicking a board is the thing
 * somebody tries when they want to put something on it, so this is what they
 * find when they do.
 *
 * Each item goes to the mechanism that actually works for that kind of thing,
 * which is why "video" is not simply another file picker -- see the comment on
 * that item.
 */
export default function BoardMenu({ at, onClose, items }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!at) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    // Capture, so a click that lands on the canvas closes the menu instead of
    // starting a stroke underneath it.
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [at, onClose]);

  if (!at) return null;

  /**
   * Kept inside the window. A menu opened near the right or bottom edge would
   * otherwise open partly off-screen, which is where the item somebody wanted
   * always seems to be.
   */
  const style = {
    left: Math.min(at.x, window.innerWidth - 232),
    top: Math.min(at.y, window.innerHeight - 8 - items.length * 38),
  };

  return (
    <div className="board-menu" style={style} ref={ref} role="menu">
      {items.map((item) =>
        item.separator ? (
          <div key={item.key} className="board-menu-sep" role="separator" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`board-menu-item ${item.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="board-menu-label">{item.label}</span>
            {item.hint ? <span className="board-menu-hint">{item.hint}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}
