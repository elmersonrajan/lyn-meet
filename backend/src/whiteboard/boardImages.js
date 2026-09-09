/**
 * Pictures pasted onto a whiteboard.
 *
 * A teacher pastes a diagram, a photograph of a page, or a screenshot, and
 * then writes on top of it. The image is the page, the strokes are the working.
 *
 * What arrives is a PNG, already scaled by the browser to the shape of a board.
 * It used to be raw pixels -- about 2.7 MB of them -- because the server had to
 * composite the picture into the class recording and its frame renderer has no
 * image decoder. It still does not: the recorder hands this file to ffmpeg,
 * which is already required for recording at all (see recording/boardPage.js).
 * So a diagram costs the two hundred kilobytes it compresses to rather than
 * three megabytes on the wire.
 *
 * These are the pages of one lesson. They are swept while the server runs, not
 * only when it restarts, and a meeting takes its pictures with it when it ends.
 */
const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("BoardImages");

const DIR = process.env.BOARD_IMAGES_DIR
  ? path.resolve(process.env.BOARD_IMAGES_DIR)
  : path.join(__dirname, "..", "..", "board-images");

/** Long enough for the lesson it was pasted into, and no longer. */
const MAX_AGE_MS = Number(process.env.BOARD_IMAGE_MAX_AGE_HOURS || 6) * 60 * 60 * 1000;

/**
 * Generous for a scaled-down board picture, and far below anything that would
 * trouble a websocket frame.
 */
const MAX_BYTES = Number(process.env.BOARD_IMAGE_MAX_BYTES || 8 * 1024 * 1024);

/** A PNG says so in its first eight bytes, whatever it is called. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function looksLikePng(buffer) {
  return (
    Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)
  );
}

function safeId(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || "")) ? String(id) : null;
}

/** The meeting a stored file belongs to, which is the first part of its name. */
function meetingKey(meetingId) {
  return (
    String(meetingId || "meeting")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 48) || "meeting"
  );
}

/**
 * Stores one pasted picture.
 *
 * @param {string} meetingId
 * @param {Buffer} png
 * @returns {{id: string, url: string}}
 */
function save(meetingId, png) {
  const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png || []);
  if (!buffer.length) throw new Error("That picture arrived empty");
  if (!looksLikePng(buffer)) throw new Error("That picture did not arrive as an image");
  if (buffer.length > MAX_BYTES) {
    throw new Error(
      `That picture is ${Math.round(buffer.length / (1024 * 1024))} MB, which is more than a board needs`,
    );
  }

  fs.mkdirSync(DIR, { recursive: true });
  const id = `${meetingKey(meetingId)}_${Date.now()}`;
  fs.writeFileSync(path.join(DIR, `${id}.png`), buffer);

  log.action("board picture stored", { meetingId, id, bytes: buffer.length });
  return { id, url: `/board-images/${id}.png` };
}

/** Everything this meeting pasted, gone the moment the meeting is. */
function removeForMeeting(meetingId) {
  try {
    if (!fs.existsSync(DIR)) return 0;
    const prefix = `${meetingKey(meetingId)}_`;
    let removed = 0;
    for (const name of fs.readdirSync(DIR)) {
      if (!name.startsWith(prefix)) continue;
      try {
        fs.unlinkSync(path.join(DIR, name));
        removed += 1;
      } catch (err) {
        log.error("could not remove a board picture", { name, error: err.message });
      }
    }
    if (removed) log.info("board pictures removed with the meeting", { meetingId, removed });
    return removed;
  } catch (err) {
    log.error("removeForMeeting failed", err);
    return 0;
  }
}

/** Deletes anything older than a lesson. */
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
        log.error("could not remove an old board picture", { name, error: err.message });
      }
    }
    if (removed) log.info("old board pictures removed", { removed });
    return removed;
  } catch (err) {
    log.error("board picture sweep failed", err);
    return 0;
  }
}

module.exports = { DIR, MAX_BYTES, save, sweep, removeForMeeting, safeId, looksLikePng };
