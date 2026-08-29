const fs = require("fs");
const path = require("path");

/**
 * Where recordings live, plus the two file helpers everything in the pipeline
 * needs.
 *
 * Kept in its own module so the capture side and the background renderer can
 * both use them without importing each other: the renderer must not depend on
 * the recorder, because it runs long after the recorder, the room and the
 * teacher have all gone.
 */
const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || path.join(__dirname, "../../recordings"),
);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileSize(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

module.exports = { RECORDINGS_DIR, ensureDir, fileSize };
