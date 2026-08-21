import { useCallback, useEffect, useRef, useState } from "react";
import { emitAck } from "../services/socket";

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
        ctx.lineWidth = s.width || 3;
        ctx.beginPath();
        s.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }
    } catch (err) {
      console.error("[Whiteboard] redraw failed", err);
    }
  }, []);

  useEffect(() => {
    strokesRef.current = initial || [];
    redraw();
  }, [initial, redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const resize = () => {
      try {
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        redraw();
      } catch (err) {
        console.error("[Whiteboard] resize failed", err);
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [redraw]);

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
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  };

  const onDown = (e) => {
    try {
      if (!isTeacher) return;
      drawing.current = { color, width: 3, points: [pos(e)] };
    } catch (err) {
      console.error("[Whiteboard] onDown failed", err);
    }
  };

  const onMove = (e) => {
    try {
      if (!isTeacher || !drawing.current) return;
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
