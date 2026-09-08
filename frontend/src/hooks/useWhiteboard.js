import { useCallback, useEffect, useRef, useState } from "react";
import { emitAck } from "../services/socket";
import { imageFrom, toBoardPng, readClipboardImage } from "../services/boardImage";
import { documentFrom, openDocument, renderPage } from "../services/boardDocument";

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
 * canDraw = teacher only. Coordinators supervise and may change the stage or
 * share a screen, but do not write on the board; the server enforces this too.
 */
export function useWhiteboard({
  socket,
  canDraw = false,
  isTeacher,
  initial = [],
  initialImage = null,
  initialDocument = null,
  onError,
}) {
  // Back-compat: older callers passed isTeacher
  const allowed = canDraw || Boolean(isTeacher);

  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const dprRef = useRef(1);
  const cssSizeRef = useRef({ w: 1, h: 1 });
  const [color, setColor] = useState("#163a6b");
  const [tool, setTool] = useState("pen");
  const strokesRef = useRef(initial || []);
  /**
   * The picture pasted onto this board, decoded and ready to draw.
   *
   * Held as a loaded <img> rather than a URL so a redraw -- which happens on
   * every stroke and every resize -- never waits on the network.
   */
  const imageRef = useRef(null);
  const [pasting, setPasting] = useState(false);
  /**
   * The open document, kept so that turning a page renders from the file
   * already parsed rather than fetching and parsing it again.
   */
  const pdfRef = useRef({ url: null, doc: null, pages: 0 });
  const [documentState, setDocumentState] = useState(initialDocument || null);

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

      // Underneath everything: the strokes are the working, the picture is the
      // page. It arrives already fitted to the board's proportions, so it is
      // drawn to fill the canvas rather than fitted a second time.
      const image = imageRef.current;
      if (image) {
        try {
          ctx.drawImage(image, 0, 0, cssW, cssH);
        } catch (err) {
          console.error("[Whiteboard] could not draw the pasted picture", err);
        }
      }

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

  /**
   * Loads the board's picture, or clears it.
   *
   * The redraw is deferred until the image has actually decoded: drawing a
   * half-loaded image paints nothing, and the board would stay blank until the
   * next stroke happened to trigger another redraw.
   */
  const applyImage = useCallback(
    (image) => {
      if (!image?.url) {
        imageRef.current = null;
        redraw();
        return;
      }
      const img = new Image();
      img.onload = () => {
        imageRef.current = img;
        redraw();
      };
      img.onerror = () => {
        console.error("[Whiteboard] the board picture could not be loaded", image.url);
        imageRef.current = null;
        redraw();
      };
      img.src = image.url;
    },
    [redraw],
  );

  /**
   * Puts a document page under the strokes.
   *
   * The file is opened once and held; a page change re-renders from it. A
   * document that fails to open leaves the board blank rather than showing the
   * page before it, because a page that is silently the wrong one is worse
   * than no page at all.
   */
  const applyDocument = useCallback(
    async (doc) => {
      if (!doc?.url) {
        pdfRef.current = { url: null, doc: null, pages: 0 };
        return false;
      }
      try {
        if (pdfRef.current.url !== doc.url) {
          const opened = await openDocument(doc.url);
          pdfRef.current = { url: doc.url, doc: opened.doc, pages: opened.pages };
        }
        const canvas = await renderPage(pdfRef.current.doc, doc.page || 1);
        imageRef.current = canvas;
        redraw();
        return true;
      } catch (err) {
        console.error("[Whiteboard] could not render the document", err);
        imageRef.current = null;
        redraw();
        onError?.("That document could not be shown");
        return false;
      }
    },
    [redraw, onError],
  );

  /**
   * Sends a pasted or dropped picture to the class.
   *
   * Scaled to a board frame here rather than on the server, which has no image
   * decoder and should not acquire one: what goes on the wire is pixels, and
   * the only thing that can be wrong with pixels is their length.
   */
  const sendImage = useCallback(
    async (file) => {
      if (!allowed || !file) return;
      setPasting(true);
      try {
        const png = await toBoardPng(file);
        console.log("[Whiteboard] sharing a picture", { bytes: png.byteLength });
        await emitAck("whiteboard-image", { png });
      } catch (err) {
        // Loudly. A picture that silently fails to appear is a teacher
        // pasting it three more times in front of a class.
        console.error("[Whiteboard] paste failed", err);
        onError?.(err.message || "That picture could not be shared");
      } finally {
        setPasting(false);
      }
    },
    [allowed, onError],
  );

  /**
   * Paste, from a menu rather than a keystroke.
   *
   * The paste EVENT only fires for Ctrl+V, so a menu item has to ask the
   * clipboard directly -- which needs permission. Chrome asks once and
   * remembers; a refusal is not a fault, so it is answered with the keystroke
   * that needs no permission at all.
   */
  const pasteFromClipboard = useCallback(async () => {
    if (!allowed) return;
    try {
      const blob = await readClipboardImage();
      if (!blob) {
        onError?.("There is no picture on the clipboard. Copy one first.");
        return;
      }
      await sendImage(blob);
    } catch (err) {
      console.warn("[Whiteboard] clipboard read refused", err.name || err.message);
      onError?.("This browser will not read the clipboard from a menu — press Ctrl+V instead");
    }
  }, [allowed, sendImage, onError]);

  /**
   * Sends a document to the class: a PDF, or a Word file the server will
   * convert. Read here and sent whole over the socket, which no proxy
   * body-size limit applies to.
   */
  const sendDocument = useCallback(
    async (file) => {
      if (!allowed || !file) return;
      setPasting(true);
      try {
        const bytes = await file.arrayBuffer();
        await emitAck("whiteboard-document", { bytes, name: file.name, type: file.type });
      } catch (err) {
        console.error("[Whiteboard] document failed", err);
        onError?.(err.message || "That document could not be shared");
      } finally {
        setPasting(false);
      }
    },
    [allowed, onError],
  );

  /** Turns the page for the whole class. */
  const setPage = useCallback(
    async (page) => {
      if (!allowed) return;
      try {
        await emitAck("whiteboard-document-page", { page });
      } catch (err) {
        console.error("[Whiteboard] page turn failed", err);
        onError?.(err.message);
      }
    },
    [allowed, onError],
  );

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

  // Whatever was already on the board when this browser arrived.
  useEffect(() => {
    if (initialDocument) applyDocument(initialDocument);
    else applyImage(initialImage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImage, initialDocument]);

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

  /**
   * Paste is a window-level event because it has no target of its own: a
   * canvas cannot take focus, so Ctrl+V would otherwise land on the document
   * and be ignored. Anything that is not an image is left alone -- pasting
   * text into the chat box must go on working.
   */
  useEffect(() => {
    if (!allowed) return undefined;
    const onPaste = (e) => {
      const doc = documentFrom(e.clipboardData);
      if (doc) {
        e.preventDefault();
        sendDocument(doc);
        return;
      }
      const file = imageFrom(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      sendImage(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [allowed, sendImage, sendDocument]);

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
        // Clear means clear: the page goes with the working on it.
        setDocumentState(null);
        applyDocument(null);
        applyImage(null);
        redraw();
      } catch (err) {
        console.error("[Whiteboard] remote clear failed", err);
      }
    };
    /**
     * The teacher moved the class to another board.
     *
     * The strokes arrive with the switch rather than being remembered here:
     * what this browser paints is then exactly what the server holds for the
     * page everyone was just moved to, which makes a tab switch, a late join
     * and a reconnect all end in the same picture.
     */
    const onSwitched = ({ strokes, image, document: doc }) => {
      try {
        console.log("[Whiteboard] board switched", {
          strokes: strokes?.length || 0,
          image: image?.id,
          document: doc?.id,
        });
        strokesRef.current = Array.isArray(strokes) ? [...strokes] : [];
        setDocumentState(doc || null);
        if (doc) applyDocument(doc);
        else applyImage(image);
        redraw();
      } catch (err) {
        console.error("[Whiteboard] board switch failed", err);
      }
    };

    // A page turn is a number, not a board: the document is already open in
    // every browser, and re-sending it to move one page would be absurd.
    const onPage = ({ page }) => {
      setDocumentState((current) => {
        if (!current) return current;
        const next = { ...current, page };
        applyDocument(next);
        return next;
      });
    };

    socket.on("whiteboard-stroke", onStroke);
    socket.on("whiteboard-clear", onClear);
    socket.on("whiteboard-switched", onSwitched);
    socket.on("whiteboard-page", onPage);
    return () => {
      socket.off("whiteboard-stroke", onStroke);
      socket.off("whiteboard-clear", onClear);
      socket.off("whiteboard-switched", onSwitched);
      socket.off("whiteboard-page", onPage);
    };
  }, [socket, redraw, applyImage, applyDocument]);

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
    // Dropping a file onto the board goes through the same path as a paste.
    sendImage,
    sendDocument,
    pasteFromClipboard,
    setPage,
    // What is on the board, for the page controls: null unless a document is
    // open on it.
    document: documentState,
    pageCount: pdfRef.current.pages,
    onDropFiles: (dataTransfer) => {
      const doc = documentFrom(dataTransfer);
      if (doc) {
        sendDocument(doc);
        return true;
      }
      const file = imageFrom(dataTransfer);
      if (file) sendImage(file);
      return Boolean(file);
    },
    pasting,
  };
}
