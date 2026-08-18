import React from "react";

export default function Whiteboard({ board }) {
  return (
    <canvas
      ref={board.canvasRef}
      onMouseDown={board.onDown}
      onMouseMove={board.onMove}
      onMouseUp={board.onUp}
      onMouseLeave={board.onUp}
      onTouchStart={board.onDown}
      onTouchMove={board.onMove}
      onTouchEnd={board.onUp}
      style={{ cursor: "crosshair" }}
    />
  );
}
