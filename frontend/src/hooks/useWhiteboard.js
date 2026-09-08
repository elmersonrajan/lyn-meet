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
  initialView = null,
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
   * Whether the board is showing a page rather than being a page.
   *
   * A picture or a document is put up to be read, not written on: strokes
   * across a diagram sit in positions that mean something about the diagram,
   * and a page turn makes nonsense of them. Held as a ref because the pointer
   * handlers are called from events rather than from a render.
   */
  const showingRef = useRef(Boolean(initialImage || initialDocument));
  const [showing, setShowing] = useState(showingRef.current);

  const setShowingContent = useCallback((value) => {
    showingRef.current = Boolean(value);
    setShowing(showingRef.current);
  }, []);
  /**
   * The open document, kept so that turning a page renders from the file
   * already parsed rather than fetching and parsing it again.
   */
  const pdfRef = useRef({ url: null, doc: null, pages: 0 });
  const [documentState, setDocumentState] = useState(initialDocument || null);
  /**
   * How far into the page this board is looking: a scale, and an offset in
   * units of the board itself.
   *
   * Held in a ref as well as in state because every redraw and every pointer
   * position needs it, and neither can wait for a render.
   */
  const viewRef = useRef(initialView || { scale: 1, tx: 0, ty: 0 });
  const [view, setViewState] = useState(viewRef.current);

  /** The last view sent, and when, so a drag does not become a flood of messages. */
  const sentRef = useRef({ at: 0, timer: 0 });

  const normalise = (next) => {
    const scale = Math.min(6, Math.max(1, Number(next?.scale) || 1));
    // The only place there is to pan is the part of the page that zooming in
    // pushed off the edge; at a scale of 1 there is nowhere to go.
    const room = (1 - 1 / scale) / 2;
    const clamp = (value) => Math.min(room, Math.max(-room, Number(value) || 0));
    return { scale, tx: clamp(next?.tx), ty: clamp(next?.ty) };
  };

  const applyView = useCallback((next) => {
    viewRef.current = normalise(next);
    setViewState(viewRef.current);
  }, []);

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

      /**
       * The zoom, applied to the page AND the working on it.
       *
       * Magnifying the picture alone would leave every annotation floating
       * over the wrong part of it. Both are drawn through the same transform,
       * so a circle round a word stays round that word at any zoom.
       */
      const { scale, tx, ty } = viewRef.current;
      if (scale !== 1 || tx || ty) {
        ctx.translate(cssW / 2, cssH / 2);
        ctx.scale(scale, scale);
        ctx.translate(-cssW / 2 - tx * cssW, -cssH / 2 - ty * cssH);
      }

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
   * Moves the class's view of the page.
   *
   * Sent to the server rather than applied locally and announced: the server
   * clamps it and owns it, so a late joiner and a board switch both land on
   * the same view instead of on whatever this browser last did.
   */
  /**
   * Tells the class where the page is, at most a dozen times a second.
   *
   * A drag produces a mouse event every frame. Sending each one would put
   * sixty messages a second on the wire to move one page, and the last of them
   * is the only one that matters -- so the rest are dropped and a trailing
   * send makes sure the final position is not one of the dropped ones.
   */
  const publishView = useCallback(
    (immediate = false) => {
      if (!allowed) return;
      const send = () => {
        sentRef.current.at = performance.now();
        emitAck("whiteboard-view", viewRef.current).catch((err) =>
          console.error("[Whiteboard] zoom failed", err),
        );
      };
      clearTimeout(sentRef.current.timer);
      const since = performance.now() - sentRef.current.at;
      if (immediate || since > 80) send();
      else sentRef.current.timer = setTimeout(send, 80 - since);
    },
    [allowed],
  );

  /**
   * Moves the class's view of the page. Immediately, with no easing.
   *
   * Applied locally as well as sent, so the teacher's own zoom does not wait
   * on a round trip to appear.
   */
  const setView = useCallback(
    (next) => {
      if (!allowed) return;
      applyView(next);
      redraw();
      publishView(true);
    },
    [allowed, applyView, redraw, publishView],
  );

  /**
   * Zooms about a point on the board, given in 0..1 board units.
   *
   * @param {number} factor
   * @param {{x:number,y:number}} at
   */
  const zoomAt = useCallback(
    (factor, at = { x: 0.5, y: 0.5 }) => {
      const current = viewRef.current;
      const scale = Math.min(6, Math.max(1, current.scale * factor));
      /**
       * Keeping the point under the cursor still.
       *
       * Zooming about the middle regardless would slide whatever somebody is
       * pointing at out from under them, which is the difference between a
       * magnifier and a fairground ride.
       */
      const offset = (pointer, translate) =>
        translate + (pointer - 0.5 - translate) * (1 - current.scale / scale);
      setView({ scale, tx: offset(at.x, current.tx), ty: offset(at.y, current.ty) });
    },
    [setView],
  );

  /**
   * Dragging the page with the mouse.
   *
   * Shift and drag was the only way to move a zoomed page, which is to say
   * there was no way to move it: nobody finds a modifier nobody mentioned.
   * Now a plain drag moves it whenever the board is not also a surface to draw
   * on -- which is exactly when a page is up, and exactly when somebody
   * zoomed in. On a writable board the pen keeps the plain drag and Shift
   * moves the page.
   *
   * No easing: a page being dragged has to sit under the pointer, and easing
   * towards it would feel like dragging something through treacle.
   */
  const panFrom = useCallback(
    (event) => {
      if (!allowed || viewRef.current.scale <= 1) return false;
      const canvas = canvasRef.current;
      if (!canvas) return false;
      const rect = canvas.getBoundingClientRect();
      const start = {
        x: event.clientX,
        y: event.clientY,
        view: viewRef.current,
      };
      const move = (e) => {
        const point = e.touches ? e.touches[0] : e;
        const scale = start.view.scale;
        applyView({
          scale,
          tx: start.view.tx - (point.clientX - start.x) / ((rect.width || 1) * scale),
          ty: start.view.ty - (point.clientY - start.y) / ((rect.height || 1) * scale),
        });
        redraw();
        publishView();
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("touchmove", move);
        window.removeEventListener("touchend", up);
        // The dropped middle of a drag does not matter; where it ended does.
        publishView(true);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
      return true;
    },
    [allowed, applyView, redraw, publishView],
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
   * Ctrl and the wheel zooms the board, not the browser.
   *
   * This has to be a native listener registered with `passive: false`. React
   * attaches its own wheel handling to the document as PASSIVE, which means a
   * preventDefault() inside an onWheel prop is ignored -- so the gesture fell
   * through to Chrome and zoomed the whole window instead of the page on the
   * board. There is no way to ask React for a non-passive wheel listener, so
   * the canvas gets one of its own.
   *
   * Only with a modifier held. A bare wheel over a board should scroll the
   * page like anything else.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !allowed) return undefined;

    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      /**
       * Proportional to how hard the wheel was turned.
       *
       * A trackpad sends many tiny deltas and a mouse wheel a few large ones;
       * taking the size into account makes both feel like the same gesture.
       */
      const step = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0022);
      zoomAt(step, {
        x: (e.clientX - rect.left) / (rect.width || 1),
        y: (e.clientY - rect.top) / (rect.height || 1),
      });
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [allowed, zoomAt]);

  /**
   * Ctrl with + - or 0 zooms the board too, for the same reason.
   *
   * Otherwise those keys zoom Chrome, which rescales the entire meeting -- the
   * toolbar, the roster, the video tiles -- to magnify a paragraph. Only for
   * whoever can drive the board: a student's browser zoom is their own
   * business, and somebody who needs a larger interface still has Chrome's
   * menu for it.
   */
  useEffect(() => {
    if (!allowed) return undefined;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      // An input has the keyboard: a teacher typing a poll question means the
      // characters, not the board.
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAt(1.4);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAt(1 / 1.4);
      } else if (e.key === "0") {
        e.preventDefault();
        setView({ scale: 1, tx: 0, ty: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allowed, zoomAt, setView]);

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
        // Clear means clear: the page goes with the working on it, and the
        // board takes ink again.
        setDocumentState(null);
        setShowingContent(false);
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
    const onSwitched = (payload) => {
      const { strokes, image, document: doc } = payload;
      try {
        console.log("[Whiteboard] board switched", {
          strokes: strokes?.length || 0,
          image: image?.id,
          document: doc?.id,
        });
        strokesRef.current = Array.isArray(strokes) ? [...strokes] : [];
        setDocumentState(doc || null);
        setShowingContent(doc || image);
        applyView(payload.view);
        if (doc) applyDocument(doc);
        else applyImage(image);
        redraw();
      } catch (err) {
        console.error("[Whiteboard] board switch failed", err);
      }
    };

    // The teacher moved everyone's view of the page.
    const onView = ({ view: next }) => {
      applyView(next);
      redraw();
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
    socket.on("whiteboard-view", onView);
    return () => {
      socket.off("whiteboard-stroke", onStroke);
      socket.off("whiteboard-clear", onClear);
      socket.off("whiteboard-switched", onSwitched);
      socket.off("whiteboard-page", onPage);
      socket.off("whiteboard-view", onView);
    };
  }, [socket, redraw, applyImage, applyDocument, applyView, setShowingContent]);

  /**
   * Where on the PAGE a pointer is, not where on the screen.
   *
   * The transform in redraw moves the page under the canvas, so a click has to
   * be moved back through it. Without this, drawing while zoomed in would put
   * the ink wherever the page happened to have been before the zoom.
   */
  const pos = (e) => {
    const canvas = canvasRef.current;
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    const w = r.width || 1;
    const h = r.height || 1;
    const screenX = src.clientX - r.left;
    const screenY = src.clientY - r.top;

    const { scale, tx, ty } = viewRef.current;
    const x = (screenX - w / 2) / scale + w / 2 + tx * w;
    const y = (screenY - h / 2) / scale + h / 2 + ty * h;

    return { x, y, nx: x / w, ny: y / h };
  };

  const onDown = (e) => {
    try {
      if (!allowed || showingRef.current) return;
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
      if (!allowed || showingRef.current || !drawing.current) return;
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
      if (!allowed || showingRef.current || !drawing.current) return;
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
    /**
     * Whether the pen is available. Separate from `allowed`, which still lets
     * the teacher zoom, turn pages, paste, and clear -- clearing is how a
     * board that is showing something becomes a board to write on again.
     */
    canInk: allowed && !showing,
    showing,
    fitCanvas,
    // Dropping a file onto the board goes through the same path as a paste.
    sendImage,
    sendDocument,
    pasteFromClipboard,
    setPage,
    view,
    zoomAt,
    setView,
    panFrom,
    /** Whether a plain drag moves the page rather than drawing on it. */
    canPan: allowed && view.scale > 1,
    resetView: () => setView({ scale: 1, tx: 0, ty: 0 }),
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
