/**
 * Video files a teacher plays to the class.
 *
 * Sharing a clip used to mean picking a file, which produced a blob URL that
 * existed in exactly one browser: the teacher watched the video and the class
 * watched an empty stage. Screen-sharing it instead would carry the picture but
 * not the sound, and would spend a webcam's worth of bandwidth on video the
 * server already has.
 *
 * So the file is uploaded once and every browser plays it from here. Each
 * student gets the original audio, at their own quality, and can be told to
 * jump to the same point in it as everybody else.
 *
 * These are teaching materials, not recordings of children, but they are still
 * only served to somebody signed in -- and they are swept up after a day,
 * because a clip is for a lesson rather than for keeping.
 */
const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("Clips");

const CLIPS_DIR = process.env.CLIPS_DIR
  ? path.resolve(process.env.CLIPS_DIR)
  : path.join(__dirname, "..", "..", "clips");

/** Long enough for the lesson it was uploaded for, and no longer. */
const MAX_AGE_MS = Number(process.env.CLIP_MAX_AGE_HOURS || 24) * 60 * 60 * 1000;

const EXTENSIONS = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
};

/**
 * The stored name is built here and never taken from the client.
 *
 * What the browser called the file is only ever used as a label; the thing
 * that reaches the filesystem is a meeting id, a timestamp and an extension
 * chosen from a fixed list.
 */
function storedName(meetingId, contentType) {
  const safeMeeting = String(meetingId || "meeting")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48) || "meeting";
  const ext = EXTENSIONS[String(contentType || "").toLowerCase().split(";")[0]] || ".mp4";
  return `${safeMeeting}_${Date.now()}${ext}`;
}

function isSupported(contentType) {
  return Boolean(EXTENSIONS[String(contentType || "").toLowerCase().split(";")[0]]);
}

function save(meetingId, buffer, contentType) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const name = storedName(meetingId, contentType);
  fs.writeFileSync(path.join(CLIPS_DIR, name), buffer);
  log.action("clip stored", { meetingId, name, bytes: buffer.length });
  return { name, src: `/clips/${name}` };
}

/**
 * Deletes clips older than a day.
 *
 * Run at boot rather than on a timer: the server is restarted often enough,
 * and a sweep that only happens while the process is alive is one more thing
 * that can quietly stop happening.
 */
function sweep(now = Date.now()) {
  try {
    if (!fs.existsSync(CLIPS_DIR)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(CLIPS_DIR)) {
      const file = path.join(CLIPS_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs < MAX_AGE_MS) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch (err) {
        log.error("could not remove an old clip", { name, error: err.message });
      }
    }
    if (removed) log.info("old clips removed", { removed });
    return removed;
  } catch (err) {
    log.error("clip sweep failed", err);
    return 0;
  }
}

module.exports = { CLIPS_DIR, EXTENSIONS, isSupported, storedName, save, sweep };
