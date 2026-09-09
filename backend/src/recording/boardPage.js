/**
 * The page behind the strokes, drawn by the server.
 *
 * A whiteboard is two things: the working, which is a list of strokes the
 * server has always been able to draw, and the page it is written on -- a
 * pasted diagram, or one page of a PDF. The server holds both of those as
 * files already, because every browser in the room fetches them from here. It
 * simply had no way to turn them into pixels, which is why a recording ever
 * needed the teacher's screen at all.
 *
 * This closes that gap. Nothing is captured from anybody's browser: the same
 * file the class is looking at is decoded here, once, and kept as the fitted
 * frame the recorder draws over.
 *
 * Two outside programs do the decoding, and both are optional:
 *
 *   - ffmpeg, which is already required for recording at all, turns any image
 *     into raw pixels at exactly the frame size;
 *   - poppler (`pdftoppm`, or `pdftocairo`) turns one page of a PDF into an
 *     image. Without it a recording still gets the strokes and says in its
 *     `dropped` list that the document page is missing, rather than failing.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const boardImages = require("../whiteboard/boardImages");
const documents = require("../whiteboard/documents");
const { createLogger } = require("../utils/logger");
const { FRAME_W, FRAME_H, BG_HEX } = require("./whiteboardFrame");

const log = createLogger("BoardPage");

const BYTES = FRAME_W * FRAME_H * 3;

/** How many decoded pages to keep. A lesson moves through a handful of them. */
const CACHE_MAX = Number(process.env.BOARD_PAGE_CACHE || 16);

/** Beyond this a page is not slow, it is broken. */
const RENDER_TIMEOUT_MS = Number(process.env.BOARD_PAGE_TIMEOUT_MS || 20000);

/** Enough dots for a page of text to stay readable at 1280 wide. */
const PDF_DPI = Number(process.env.BOARD_PAGE_PDF_DPI || 110);

/**
 * What identifies a page.
 *
 * A board shows a picture or a document, never both, and a document is only
 * ever showing one page. Two boards on the same picture are the same pixels,
 * which is the whole reason this is keyed rather than rendered per frame.
 *
 * @returns {string|null} null when the board is a blank page
 */
function pageKey(board) {
  if (!board) return null;
  if (board.image && board.image.id) return `img:${board.image.id}`;
  if (board.document && board.document.id) {
    const page = Math.max(1, Math.round(Number(board.document.page) || 1));
    return `doc:${board.document.id}:${page}`;
  }
  return null;
}

/** key -> { pixels: Buffer|null, failed: boolean } once a render has finished. */
const cache = new Map();
/** key -> Promise, so forty frames a minute do not start forty renders. */
const inFlight = new Map();

function remember(key, pixels) {
  cache.set(key, pixels);
  while (cache.size > CACHE_MAX) {
    // Insertion order: the oldest page is the one the class has moved on from.
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

let poppler;

/**
 * Which PDF rasteriser this machine has, if any. Looked up once -- the answer
 * is a property of the server, not of the document.
 */
function findPoppler() {
  if (poppler !== undefined) return poppler;
  poppler = null;
  for (const name of ["pdftoppm", "pdftocairo"]) {
    try {
      const which = process.platform === "win32" ? "where" : "which";
      const found = execFileSync(which, [name], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .split(/\r?\n/)[0]
        .trim();
      if (found) {
        poppler = { command: found, name };
        break;
      }
    } catch {
      // Not installed under that name. The next candidate, or none.
    }
  }
  if (poppler) log.info("PDF pages can be drawn into recordings", poppler);
  else
    log.warn(
      "no pdftoppm or pdftocairo — a document on the board will be missing from recordings (install poppler-utils)",
    );
  return poppler;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: BYTES + 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || "").slice(0, 400);
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Any image file, as raw pixels at exactly the frame size.
 *
 * Fitted rather than stretched, and laid over the board's own background
 * colour, so a portrait page on a landscape board looks like a page on a board
 * instead of a squashed one.
 *
 * A plain `pad` would do the fitting, but not the other half: a screenshot
 * pasted with a transparent background flattens to black under `rgb24`, and a
 * diagram would arrive as a black rectangle with lines on it. Compositing over
 * a solid board colour handles both at once.
 */
async function decodeImage(file) {
  const stdout = await run(
    "ffmpeg",
    [
      "-y",
      "-loglevel", "error",
      "-i", file,
      "-filter_complex",
      `color=c=${BG_HEX}:s=${FRAME_W}x${FRAME_H}[bg];` +
        `[0:v]scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=decrease,` +
        `format=rgba[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`,
      "-frames:v", "1",
      "-pix_fmt", "rgb24",
      "-f", "rawvideo",
      "-",
    ],
    { encoding: "buffer" },
  );
  const pixels = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (pixels.length !== BYTES) {
    throw new Error(`decoded ${pixels.length} bytes, expected ${BYTES}`);
  }
  return pixels;
}

/** One page of a PDF, via poppler, into a temporary PNG that is then decoded. */
async function decodePdfPage(file, page) {
  const tool = findPoppler();
  if (!tool) return null;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lynmeet-page-"));
  try {
    const prefix = path.join(work, "page");
    await run(tool.command, [
      "-png",
      "-r", String(PDF_DPI),
      "-f", String(page),
      "-l", String(page),
      "-singlefile",
      file,
      prefix,
    ]);
    const produced = fs
      .readdirSync(work)
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .map((f) => path.join(work, f))[0];
    if (!produced) throw new Error("poppler produced no image");
    return await decodeImage(produced);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function render(key) {
  if (key.startsWith("img:")) {
    const id = boardImages.safeId(key.slice(4));
    if (!id) throw new Error("not a picture id");
    return decodeImage(path.join(boardImages.DIR, `${id}.png`));
  }
  const [, id, page] = key.split(":");
  if (!documents.safeId(id)) throw new Error("not a document id");
  return decodePdfPage(path.join(documents.DIR, `${id}.pdf`), Math.max(1, Number(page) || 1));
}

/**
 * The pixels behind this board's strokes, if they are ready.
 *
 * Deliberately not a promise. This is called from the snapshot timer while a
 * class is running, and a frame must never wait on a PDF: the first frame or
 * two after a page is opened are drawn without it, and every frame after that
 * has it. A page that cannot be drawn is remembered as such so the failure
 * costs one attempt, not one per second for the rest of the lesson.
 *
 * @returns {{key: string|null, pixels: Buffer|null, pending: boolean, failed: boolean}}
 */
function pixelsFor(board) {
  const key = pageKey(board);
  if (!key) return { key: null, pixels: null, pending: false, failed: false };
  if (cache.has(key)) {
    const pixels = cache.get(key);
    return { key, pixels, pending: false, failed: pixels === null };
  }
  if (!inFlight.has(key)) {
    const job = render(key)
      .then((pixels) => {
        remember(key, pixels || null);
        if (pixels) log.info("board page ready", { key });
        else log.warn("board page cannot be drawn on this server", { key });
      })
      .catch((err) => {
        remember(key, null);
        log.error("board page failed", { key, error: err.message, stderr: err.stderr });
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return { key, pixels: null, pending: true, failed: false };
}

/** Forgets a meeting's pages, which are deleted with the meeting anyway. */
function forget(meetingId) {
  const marker = String(meetingId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!marker) return 0;
  let removed = 0;
  for (const key of [...cache.keys()]) {
    if (!key.includes(marker)) continue;
    cache.delete(key);
    removed += 1;
  }
  return removed;
}

module.exports = {
  pageKey,
  pixelsFor,
  forget,
  findPoppler,
  canDrawPdf: () => Boolean(findPoppler()),
  // For the tests, which must not inherit a cache from another case.
  _reset: () => {
    cache.clear();
    inFlight.clear();
    poppler = undefined;
  },
  _cache: cache,
};
