import { useCallback, useEffect, useRef, useState } from "react";
import { emitAck } from "../services/socket";

/** Map stroke point onto CSS pixel space (nx/ny preferred). */
function mapPoint(p, cssW, cssH, stroke) {
  if (p.nx != null && p.ny != null) {
    return { x: p.nx * cssW, y: p.ny * cssH };
  }
  const srcW = stroke?.canvasWidth || p.canvasWidth || cssW;
  const srcH = stroke?.canvasHeight || p.canvasHeight || cssH;
  if (srcW > 0 && srcH > 0) {
    return { x: (Number(p.x) / srcW) * cssW, y: (Number(p.y) / srcH) * cssH };
  }
  return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
}

/** Smooth path with quadratic midpoints for less jagged lines. */
function strokePath(ctx, points, cssW, cssH, stroke) {
  if (!points.length) return;
  const pts = points.map((p) => mapPoint(p, cssW, cssH, stroke));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) {
    ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  } else if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    for (let i = 1; i < pts.length - 1; i += 1) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
  }
  ctx.stroke();
}

/**
 * @param {{ socket: any, canDraw: boolean, initial?: any[] }} opts
 * canDraw = teacher OR coordinator (admin)
 */
export function useWhiteboard({ socket, canDraw = false, isTeacher, initial = [] }) {
  // Back-compat: older callers passed isTeacher
  const allowed = canDraw || Boolean(isTeacher);

  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const dprRef = useRef(1);
  const cssSizeRef = useRef({ w: 1, h: 1 });
  const [color, setColor] = useState("#163a6b");
  const [tool, setTool] = useState("pen");
  const strokesRef = useRef(initial || []);

  const redraw = useCallback(() => {
    try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;

      const dpr = dprRef.current || 1;
      const cssW = cssSizeRef.current.w;
      const cssH = cssSizeRef.current.h;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.miterLimit = 2;

      for (const s of strokesRef.current) {
        if (!s.points || !s.points.length) continue;
        ctx.strokeStyle = s.color || "#163a6b";
        const base = s.width || 3.5;
        // Thickness stays stable relative to board CSS size
        const scale = Math.min(Math.max(cssW / (s.canvasWidth || cssW), 0.75), 2);
        ctx.lineWidth = Math.max(2, base * scale);
        strokePath(ctx, s.points, cssW, cssH, s);
      }
    } catch (err) {
      console.error("[Whiteboard] redraw failed", err);
    }
  }, []);

  const fitCanvas = useCallback(() => {
    try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();
      // GUARD: Skip resizing if container is hidden or collapsed (e.g. during tab/stage transitions)
      if (rect.width < 50 || rect.height < 50) return;

      const cssW = Math.round(rect.width);
      const cssH = Math.round(rect.height);
      // Cap DPR at 2.5 — sharp enough for HiDPI/Retina screens
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      dprRef.current = dpr;
      cssSizeRef.current = { w: cssW, h: cssH };

      const needW = Math.round(cssW * dpr);
      const needH = Math.round(cssH * dpr);

      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = needW;
        canvas.height = needH;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        console.log("[Whiteboard] resize HiDPI", { cssW, cssH, dpr, needW, needH });
      }
      redraw();
    } catch (err) {
      console.error("[Whiteboard] resize failed", err);
    }
  }, [redraw]);

  useEffect(() => {
    strokesRef.current = initial || [];
    fitCanvas();
  }, [initial, fitCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    fitCanvas();
    const parent = canvas.parentElement;
    let ro;
    try {
      if (parent && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => fitCanvas());
        ro.observe(parent);
      }
    } catch (err) {
      console.error("[Whiteboard] ResizeObserver failed", err);
    }

    window.addEventListener("resize", fitCanvas);
    window.addEventListener("orientationchange", fitCanvas);
    window.visualViewport?.addEventListener("resize", fitCanvas);
    const t = setTimeout(fitCanvas, 60);

    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", fitCanvas);
      window.removeEventListener("orientationchange", fitCanvas);
      window.visualViewport?.removeEventListener("resize", fitCanvas);
      try {
        ro?.disconnect();
      } catch (err) {
        console.error("[Whiteboard] observer disconnect failed", err);
      }
    };
  }, [fitCanvas]);

  useEffect(() => {
    if (!socket) return undefined;
    const onStroke = (stroke) => {
      try {
        console.log("[Whiteboard] remote stroke");
        strokesRef.current.push(stroke);
        redraw();
      } catch (err) {
        console.error("[Whiteboard] remote stroke failed", err);
      }
    };
    const onClear = () => {
      try {
        console.log("[Whiteboard] remote clear");
        strokesRef.current = [];
        redraw();
      } catch (err) {
        console.error("[Whiteboard] remote clear failed", err);
      }
    };
    socket.on("whiteboard-stroke", onStroke);
    socket.on("whiteboard-clear", onClear);
    return () => {
      socket.off("whiteboard-stroke", onStroke);
      socket.off("whiteboard-clear", onClear);
    };
  }, [socket, redraw]);

  const pos = (e) => {
    const canvas = canvasRef.current;
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    const x = src.clientX - r.left;
    const y = src.clientY - r.top;
    const w = r.width || 1;
    const h = r.height || 1;
    return {
      x,
      y,
      nx: x / w,
      ny: y / h,
    };
  };

  const onDown = (e) => {
    try {
      if (!allowed) return;
      e.preventDefault?.();
      // Eraser paints the board's own white — no protocol change, erases for everyone.
      const erasing = tool === "eraser";
      drawing.current = {
        color: erasing ? "#ffffff" : color,
        width: erasing ? 28 : 3.5,
        points: [pos(e)],
      };
    } catch (err) {
      console.error("[Whiteboard] onDown failed", err);
    }
  };

  const onMove = (e) => {
    try {
      if (!allowed || !drawing.current) return;
      e.preventDefault?.();
      const p = pos(e);
      const pts = drawing.current.points;
      const last = pts[pts.length - 1];
      // Skip near-duplicate points → cleaner paths, less jagged
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1.2) return;
      pts.push(p);
      strokesRef.current = [
        ...strokesRef.current.filter((s) => s !== drawing.current),
        drawing.current,
      ];
      redraw();
    } catch (err) {
      console.error("[Whiteboard] onMove failed", err);
    }
  };

  const onUp = async () => {
    try {
      if (!allowed || !drawing.current) return;
      const stroke = drawing.current;
      drawing.current = false;
      const { w, h } = cssSizeRef.current;
      const payload = {
        ...stroke,
        canvasWidth: w || 1280,
        canvasHeight: h || 720,
      };
      await emitAck("whiteboard-stroke", payload);
    } catch (err) {
      console.error("[Whiteboard] onUp failed", err);
    }
  };

  const clear = async () => {
    try {
      if (!allowed) return;
      console.log("[Whiteboard] clear");
      await emitAck("whiteboard-clear", {});
      strokesRef.current = [];
      redraw();
    } catch (err) {
      console.error("[Whiteboard] clear failed", err);
    }
  };

  return {
    canvasRef,
    onDown,
    onMove,
    onUp,
    clear,
    color,
    setColor,
    tool,
    setTool,
    allowed,
    fitCanvas,
  };
}
