import { useCallback, useEffect, useRef, useState } from "react";
import { emitAck } from "../services/socket";

function pointOnCanvas(p, canvas) {
  if (p.nx != null && p.ny != null) {
    return { x: p.nx * canvas.width, y: p.ny * canvas.height };
  }
  const srcW = p.canvasWidth || 1280;
  const srcH = p.canvasHeight || 720;
  return {
    x: (p.x / srcW) * canvas.width,
    y: (p.y / srcH) * canvas.height,
  };
}

export function useWhiteboard({ socket, isTeacher, initial = [] }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const [color, setColor] = useState("#163a6b");
  const strokesRef = useRef(initial || []);

  const redraw = useCallback(() => {
    try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const s of strokesRef.current) {
        ctx.strokeStyle = s.color;
        const scale = Math.max(canvas.width / (s.canvasWidth || canvas.width), 0.5);
        ctx.lineWidth = Math.max(1.5, (s.width || 3) * Math.min(scale, 2));
        ctx.beginPath();
        s.points.forEach((p, i) => {
          const pt = pointOnCanvas({ ...p, canvasWidth: s.canvasWidth, canvasHeight: s.canvasHeight }, canvas);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
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
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        console.log("[Whiteboard] resize", { w, h });
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
    const t = setTimeout(fitCanvas, 50);
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
    return {
      x,
      y,
      nx: r.width ? x / r.width : 0,
      ny: r.height ? y / r.height : 0,
    };
  };

  const onDown = (e) => {
    try {
      if (!isTeacher) return;
      e.preventDefault?.();
      drawing.current = { color, width: 3, points: [pos(e)] };
    } catch (err) {
      console.error("[Whiteboard] onDown failed", err);
    }
  };

  const onMove = (e) => {
    try {
      if (!isTeacher || !drawing.current) return;
      e.preventDefault?.();
      drawing.current.points.push(pos(e));
      strokesRef.current = [...strokesRef.current.filter((s) => s !== drawing.current), drawing.current];
      redraw();
    } catch (err) {
      console.error("[Whiteboard] onMove failed", err);
    }
  };

  const onUp = async () => {
    try {
      if (!isTeacher || !drawing.current) return;
      const stroke = drawing.current;
      drawing.current = false;
      const canvas = canvasRef.current;
      const payload = {
        ...stroke,
        canvasWidth: canvas ? canvas.width : 1280,
        canvasHeight: canvas ? canvas.height : 720,
      };
      await emitAck("whiteboard-stroke", payload);
    } catch (err) {
      console.error("[Whiteboard] onUp failed", err);
    }
  };

  const clear = async () => {
    try {
      if (!isTeacher) return;
      console.log("[Whiteboard] clear");
      await emitAck("whiteboard-clear", {});
      strokesRef.current = [];
      redraw();
    } catch (err) {
      console.error("[Whiteboard] clear failed", err);
    }
  };

  return { canvasRef, onDown, onMove, onUp, clear, color, setColor };
}
