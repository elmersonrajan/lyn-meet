const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
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

function renderPixels(strokes) {
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
  return buf;
}

function renderPng(strokes) {
  try {
    return encodePng(renderPixels(strokes), W, H);
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
function writeBoardFrame(filePath, strokes) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const usePng = /\.png$/i.test(filePath);
    fs.writeFileSync(filePath, usePng ? renderPng(strokes) : renderPpm(strokes));
    return filePath;
  } catch (err) {
    log.error("writeBoardFrame failed", filePath, err);
    throw err;
  }
}

module.exports = {
  writeBoardFrame,
  normalizeStroke,
  renderPng,
  renderPpm,
  encodePng,
  FRAME_W: W,
  FRAME_H: H,
};
