const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createLogger } = require("../utils/logger");

const log = createLogger("WhiteboardFrame");

const W = 1280;
const H = 720;
const BG = [244, 247, 251];
/** The same colour, in the form ffmpeg's `pad` filter wants. */
const BG_HEX = `0x${BG.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const FLAT_VIEW = { scale: 1, tx: 0, ty: 0 };
const MAX_SCALE = 6;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * How far into the page the class is looking, as the recording must show it.
 *
 * Clamped the same way the room clamps it, so a frame can never be built from
 * a view the class was never actually shown.
 */
function normaliseView(view) {
  const scale = clamp(Number(view?.scale) || 1, 1, MAX_SCALE);
  const room = (1 - 1 / scale) / 2;
  return {
    scale,
    tx: clamp(Number(view?.tx) || 0, -room, room),
    ty: clamp(Number(view?.ty) || 0, -room, room),
  };
}

function isFlat(view) {
  return view.scale === 1 && view.tx === 0 && view.ty === 0;
}

/**
 * A point on the page, moved to where the zoom puts it on screen.
 *
 * This is the browser's own canvas transform written out in normalised units:
 * scale about the centre, then shift by the offset. Applied to the page and to
 * the strokes alike, which is what keeps a circle round a word round that word
 * at any zoom.
 *
 * @param {number} u position along one axis, 0..1
 * @param {number} scale
 * @param {number} offset the view's tx or ty, for the same axis
 */
function throughView(u, scale, offset) {
  return 0.5 + scale * (u - 0.5 - offset);
}

/** The inverse: which point on the page is showing at this point on screen. */
function fromView(u, scale, offset) {
  return (u - 0.5) / scale + 0.5 + offset;
}

/**
 * Redraws the page under the zoom, sampled rather than copied.
 *
 * Bilinear, because a magnified diagram sampled with the nearest pixel is
 * visibly blocky and a recording is watched at full size. The cost is one pass
 * over the frame, and only on frames whose view is not flat.
 */
function resampleThroughView(base, out, view) {
  const { scale, tx, ty } = view;
  for (let y = 0; y < H; y += 1) {
    const sy = clamp(fromView((y + 0.5) / H, scale, ty) * H - 0.5, 0, H - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(H - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < W; x += 1) {
      const sx = clamp(fromView((x + 0.5) / W, scale, tx) * W - 0.5, 0, W - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(W - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * W + x0) * 3;
      const i01 = (y0 * W + x1) * 3;
      const i10 = (y1 * W + x0) * 3;
      const i11 = (y1 * W + x1) * 3;
      const target = (y * W + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const top = base[i00 + c] + (base[i01 + c] - base[i00 + c]) * fx;
        const bottom = base[i10 + c] + (base[i11 + c] - base[i10 + c]) * fx;
        out[target + c] = top + (bottom - top) * fy;
      }
    }
  }
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

function normalizeStroke(stroke, view = FLAT_VIEW) {
  try {
    const v = normaliseView(view);
    const cw = Number(stroke.canvasWidth) || W;
    const ch = Number(stroke.canvasHeight) || H;
    const points = (stroke.points || []).map((p) => {
      const u = p.nx != null && p.ny != null ? clamp(p.nx, 0, 1) : clamp((p.x || 0) / cw, 0, 1);
      const w = p.nx != null && p.ny != null ? clamp(p.ny, 0, 1) : clamp((p.y || 0) / ch, 0, 1);
      // Not clamped afterwards: a stroke the zoom has pushed off the edge
      // belongs off the edge, and clamping would smear it along the border.
      return { x: throughView(u, v.scale, v.tx) * W, y: throughView(w, v.scale, v.ty) * H };
    });
    const scale = W / cw;
    return {
      color: stroke.color || "#163a6b",
      // Magnified with the page: a line drawn at 300% is three times as thick
      // on screen, and the recording should be the same picture.
      width: Math.max(2, (Number(stroke.width) || 3) * scale * v.scale),
      points,
    };
  } catch (err) {
    log.error("normalizeStroke failed", err);
    return { color: "#163a6b", width: 3, points: [] };
  }
}

/* ---------- Minimal PNG encoder ----------
 *
 * Frames were written as PPM, which is uncompressed: 2.7 MB per frame, so an
 * hour-long class produced roughly 9 GB of temporary files before compose
 * deleted them. A whiteboard is mostly flat colour, so PNG compresses it to a
 * tiny fraction of that, and ffmpeg's image demuxer handles PNG more
 * predictably than PPM.
 *
 * Written by hand rather than pulling in a dependency: PNG needs only a CRC and
 * zlib, and zlib is built into Node.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** @param {Buffer} rgb W*H*3 bytes */
function encodePng(rgb, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none", which is
  // enough here because zlib already collapses the large flat areas.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * @param {Array} strokes
 * @param {Buffer|null} base the page under the strokes -- a pasted picture or
 *   a page of a document, already decoded to exactly this frame. Without it a
 *   recording of a lesson spent annotating a diagram would show the
 *   annotations hanging in empty space.
 * @param {{scale:number,tx:number,ty:number}} [view] how far into the page the
 *   class is looking. The recording shows what they were shown, so a teacher
 *   who zooms into a paragraph zooms the recording into it too.
 */
function renderPixels(strokes, base, view = FLAT_VIEW) {
  const v = normaliseView(view);
  const hasBase = Buffer.isBuffer(base) && base.length === W * H * 3;
  const buf = Buffer.alloc(W * H * 3);

  if (hasBase && isFlat(v)) {
    base.copy(buf);
  } else if (hasBase) {
    resampleThroughView(base, buf, v);
  } else {
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = BG[0];
      buf[i + 1] = BG[1];
      buf[i + 2] = BG[2];
    }
  }

  for (const raw of strokes || []) {
    const s = normalizeStroke(raw, v);
    const rgb = hexToRgb(s.color);
    for (let i = 1; i < s.points.length; i += 1) {
      const a = s.points[i - 1];
      const b = s.points[i];
      drawSegment(buf, a.x, a.y, b.x, b.y, s.width, rgb);
    }
  }
  return buf;
}

function renderPng(strokes, base, view) {
  try {
    return encodePng(renderPixels(strokes, base, view), W, H);
  } catch (err) {
    log.error("renderPng failed", err);
    throw err;
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

/**
 * Writes one whiteboard frame. The extension decides the format, so a caller
 * asking for .png gets PNG and an existing .ppm caller is unaffected.
 */
function writeBoardFrame(filePath, strokes, base, view) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const usePng = /\.png$/i.test(filePath);
    fs.writeFileSync(filePath, usePng ? renderPng(strokes, base, view) : renderPpm(strokes));
    return filePath;
  } catch (err) {
    log.error("writeBoardFrame failed", filePath, err);
    throw err;
  }
}

module.exports = {
  writeBoardFrame,
  normalizeStroke,
  normaliseView,
  throughView,
  fromView,
  renderPng,
  renderPixels,
  renderPpm,
  encodePng,
  FRAME_W: W,
  FRAME_H: H,
  BG_HEX,
  FLAT_VIEW,
};
