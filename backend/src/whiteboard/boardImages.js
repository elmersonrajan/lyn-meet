/**
 * Pictures pasted onto a whiteboard.
 *
 * A teacher pastes a diagram, a photograph of a page, or a screenshot of a
 * PDF, and then writes on top of it. That is the shape of the feature: the
 * image is the page, the strokes are the working.
 *
 * What arrives here is not a PNG or a JPEG -- it is raw pixels, already scaled
 * by the browser to exactly the size of a board frame. That is deliberate. The
 * server has to composite this picture into the class recording, and the frame
 * renderer is a hand-written pixel buffer with no image decoder in it. Sending
 * pixels means nothing on this side has to parse a file format that a client
 * chose: there is no decoder to get wrong, no format to be surprised by, and
 * no failure mode beyond a length that does not match.
 *
 * The browsers get a PNG, encoded here from those same pixels by the encoder
 * the recorder already uses.
 */
const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");
const { encodePng, FRAME_W, FRAME_H } = require("../recording/whiteboardFrame");

const log = createLogger("BoardImages");

const DIR = process.env.BOARD_IMAGES_DIR
  ? path.resolve(process.env.BOARD_IMAGES_DIR)
  : path.join(__dirname, "..", "..", "board-images");

/** Long enough for the lesson it was pasted into, and no longer. */
const MAX_AGE_MS = Number(process.env.BOARD_IMAGE_MAX_AGE_HOURS || 24) * 60 * 60 * 1000;

/** One board frame of 8-bit RGB. Anything else is not a board image. */
const EXPECTED_BYTES = FRAME_W * FRAME_H * 3;

/**
 * The last few images, kept in memory.
 *
 * The recorder asks for the live board's pixels once a second while a class is
 * being recorded, and reading three megabytes off disk at that rate for an
 * hour is work nobody needs done.
 */
const CACHE_LIMIT = 4;
const cache = new Map();

function remember(id, buffer) {
  cache.set(id, buffer);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function safeId(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || "")) ? String(id) : null;
}

/**
 * Stores one pasted image.
 *
 * @param {string} meetingId only for the file name, so an orphan can be traced
 * @param {Buffer} rgb exactly FRAME_W * FRAME_H * 3 bytes
 * @returns {{id: string, url: string}}
 */
function save(meetingId, rgb) {
  if (!Buffer.isBuffer(rgb) || rgb.length !== EXPECTED_BYTES) {
    throw new Error("That image did not arrive in a shape this server can use");
  }
  fs.mkdirSync(DIR, { recursive: true });

  const meeting = String(meetingId || "meeting")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48) || "meeting";
  const id = `${meeting}_${Date.now()}`;

  // The pixels, for the recording.
  fs.writeFileSync(path.join(DIR, `${id}.rgb`), rgb);
  // The same pixels as a PNG, for the browsers.
  fs.writeFileSync(path.join(DIR, `${id}.png`), encodePng(rgb, FRAME_W, FRAME_H));

  remember(id, rgb);
  log.action("board image stored", { meetingId, id, bytes: rgb.length });
  return { id, url: `/board-images/${id}.png` };
}

/**
 * The pixels behind a board, for compositing into a recording frame.
 * Returns null when there is no such image -- the recording then shows the
 * strokes on a plain background, which is wrong but not broken.
 */
function pixels(id) {
  const clean = safeId(id);
  if (!clean) return null;
  if (cache.has(clean)) return cache.get(clean);
  try {
    const buffer = fs.readFileSync(path.join(DIR, `${clean}.rgb`));
    if (buffer.length !== EXPECTED_BYTES) return null;
    remember(clean, buffer);
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Deletes images older than a day, at boot.
 *
 * These are the pages of one lesson, not a library. Run at startup rather than
 * on a timer: the server restarts often enough, and a sweep that only happens
 * while a process stays alive is one more thing that quietly stops happening.
 */
function sweep(now = Date.now()) {
  try {
    if (!fs.existsSync(DIR)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(DIR)) {
      const file = path.join(DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs < MAX_AGE_MS) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch (err) {
        log.error("could not remove an old board image", { name, error: err.message });
      }
    }
    if (removed) log.info("old board images removed", { removed });
    return removed;
  } catch (err) {
    log.error("board image sweep failed", err);
    return 0;
  }
}

module.exports = { DIR, EXPECTED_BYTES, save, pixels, sweep, safeId };
