const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("WhiteboardFrame");

const W = 1280;
const H = 720;
const BG = [244, 247, 251];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hexToRgb(hex) {
  try {
    const raw = String(hex || "#163a6b").replace("#", "");
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return [22, 58, 107];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } catch (err) {
    log.error("hexToRgb failed", err);
    return [22, 58, 107];
  }
}

function setPixel(buf, x, y, rgb) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = rgb[0];
  buf[i + 1] = rgb[1];
  buf[i + 2] = rgb[2];
}

function drawDisc(buf, cx, cy, radius, rgb) {
  const r = Math.max(1, Math.round(radius));
  for (let y = -r; y <= r; y += 1) {
    for (let x = -r; x <= r; x += 1) {
      if (x * x + y * y <= r * r) setPixel(buf, cx + x, cy + y, rgb);
    }
  }
}

function drawSegment(buf, x0, y0, x1, y1, width, rgb) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    drawDisc(buf, Math.round(x0 + dx * t), Math.round(y0 + dy * t), width / 2, rgb);
  }
}

function normalizeStroke(stroke) {
  try {
    const cw = Number(stroke.canvasWidth) || W;
    const ch = Number(stroke.canvasHeight) || H;
    const points = (stroke.points || []).map((p) => {
      if (p.nx != null && p.ny != null) {
        return { x: clamp(p.nx, 0, 1) * W, y: clamp(p.ny, 0, 1) * H };
      }
      return {
        x: clamp((p.x || 0) / cw, 0, 1) * W,
        y: clamp((p.y || 0) / ch, 0, 1) * H,
      };
    });
    const scale = W / cw;
    return {
      color: stroke.color || "#163a6b",
      width: Math.max(2, (Number(stroke.width) || 3) * scale),
      points,
    };
  } catch (err) {
    log.error("normalizeStroke failed", err);
    return { color: "#163a6b", width: 3, points: [] };
  }
}

function renderPpm(strokes) {
  try {
    const buf = Buffer.alloc(W * H * 3);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = BG[0];
      buf[i + 1] = BG[1];
      buf[i + 2] = BG[2];
    }

    for (const raw of strokes || []) {
      const s = normalizeStroke(raw);
      const rgb = hexToRgb(s.color);
      for (let i = 1; i < s.points.length; i += 1) {
        const a = s.points[i - 1];
        const b = s.points[i];
        drawSegment(buf, a.x, a.y, b.x, b.y, s.width, rgb);
      }
    }

    const header = Buffer.from(`P6\n${W} ${H}\n255\n`);
    return Buffer.concat([header, buf]);
  } catch (err) {
    log.error("renderPpm failed", err);
    throw err;
  }
}

function writeBoardFrame(filePath, strokes) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderPpm(strokes));
    return filePath;
  } catch (err) {
    log.error("writeBoardFrame failed", filePath, err);
    throw err;
  }
}

module.exports = { writeBoardFrame, normalizeStroke, FRAME_W: W, FRAME_H: H };
