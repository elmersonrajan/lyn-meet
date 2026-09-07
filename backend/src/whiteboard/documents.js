/**
 * Documents a teacher puts on the whiteboard.
 *
 * The file is stored once and every browser renders it for itself, a page at a
 * time, with the teacher's page number synchronised to the class. That is the
 * opposite of how the pasted pictures work, and deliberately so: a picture is
 * one frame and is cheapest as pixels, while a document is dozens of pages and
 * is cheapest as the file it already is -- rendered locally it also stays sharp
 * at whatever size each student's screen happens to be.
 *
 * It arrives over the socket rather than as an upload, so the body-size limit
 * on the proxy in front of this server does not apply.
 *
 * PDF is the format this understands. A Word document is converted to one
 * first, by LibreOffice, if this machine has it -- and if it does not, the
 * teacher is told to save it as a PDF rather than left with a file that
 * silently never appears.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { createLogger } = require("../utils/logger");

const log = createLogger("Documents");

const DIR = process.env.DOCUMENTS_DIR
  ? path.resolve(process.env.DOCUMENTS_DIR)
  : path.join(__dirname, "..", "..", "documents");

/** Long enough for the lesson it was opened in, and no longer. */
const MAX_AGE_MS = Number(process.env.DOCUMENT_MAX_AGE_HOURS || 6) * 60 * 60 * 1000;

/**
 * Below the socket's own 20 MB frame limit, with room for the rest of the
 * message. A document larger than this is a document that wants to be a link.
 */
const MAX_BYTES = Number(process.env.DOCUMENT_MAX_BYTES || 18 * 1024 * 1024);

/** How long LibreOffice gets before a lesson stops waiting for it. */
const CONVERT_TIMEOUT_MS = Number(process.env.DOCUMENT_CONVERT_TIMEOUT_MS || 60000);

const WORD_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
]);

const WORD_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".rtf", ".ppt", ".pptx", ".odp"]);

/** A PDF says so in its first five bytes, whatever the file is called. */
function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.subarray(0, 5).toString() === "%PDF-";
}

function safeId(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || "")) ? String(id) : null;
}

/** The name shown to the class: no path, no control characters, not too long. */
function cleanName(name, fallback = "Document") {
  const base = path
    .basename(String(name || ""))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return base ? base.slice(0, 120) : fallback;
}

/**
 * Whether this machine can turn a Word document into a PDF.
 *
 * Looked up once and remembered. The answer is a property of the server, and
 * asking the filesystem on every paste would be asking the same question all
 * lesson.
 */
let converter;

function findConverter() {
  if (converter !== undefined) return converter;
  const candidates = process.platform === "win32" ? ["soffice.exe"] : ["soffice", "libreoffice"];
  converter = null;
  for (const name of candidates) {
    try {
      const which = process.platform === "win32" ? "where" : "which";
      const found = execFileSync(which, [name], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .split(/\r?\n/)[0]
        .trim();
      if (found) {
        converter = found;
        break;
      }
    } catch {
      // Not installed under that name. The next candidate, or none.
    }
  }
  log.info(converter ? "LibreOffice found — Word documents can be shown" : "no LibreOffice — Word documents cannot be converted", {
    converter,
  });
  return converter;
}

/**
 * Converts a Word document to PDF with LibreOffice.
 *
 * Runs in a directory of its own: LibreOffice writes its output beside the
 * input under a name it chooses, and a shared directory would make two
 * conversions at once each other's business.
 */
function convertToPdf(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const soffice = findConverter();
    if (!soffice) {
      reject(
        new Error(
          "This server cannot convert Word documents. Save it as a PDF and share that instead.",
        ),
      );
      return;
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "lynmeet-doc-"));
    const ext = path.extname(cleanName(originalName, "document.docx")) || ".docx";
    const input = path.join(work, `in${ext}`);
    fs.writeFileSync(input, buffer);

    const child = spawn(
      soffice,
      ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", work, input],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Converting that document took too long"));
    }, CONVERT_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`That document could not be converted: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        const produced = fs
          .readdirSync(work)
          .filter((f) => f.toLowerCase().endsWith(".pdf"))
          .map((f) => path.join(work, f))[0];
        if (!produced) {
          log.error("LibreOffice produced no PDF", { code, stderr: stderr.slice(0, 400) });
          reject(new Error("That document could not be converted to a PDF"));
          return;
        }
        resolve(fs.readFileSync(produced));
      } catch (err) {
        reject(err);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  });
}

/**
 * Stores a document for a meeting, converting it first if it is not a PDF.
 *
 * @returns {Promise<{id: string, url: string, name: string}>}
 */
async function save(meetingId, { bytes, name, type }) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length) throw new Error("That file is empty");
  if (buffer.length > MAX_BYTES) {
    throw new Error(
      `That document is ${Math.round(buffer.length / (1024 * 1024))} MB. The limit is ${Math.round(
        MAX_BYTES / (1024 * 1024),
      )} MB.`,
    );
  }

  const display = cleanName(name);
  const extension = path.extname(display).toLowerCase();
  const isWord = WORD_TYPES.has(String(type || "").toLowerCase()) || WORD_EXTENSIONS.has(extension);

  let pdf = buffer;
  if (!looksLikePdf(buffer)) {
    if (!isWord) throw new Error("Only PDF and Word documents can be shown on the board");
    log.action("converting a document to PDF", { meetingId, name: display, bytes: buffer.length });
    pdf = await convertToPdf(buffer, display);
    if (!looksLikePdf(pdf)) throw new Error("That document could not be converted to a PDF");
  }

  fs.mkdirSync(DIR, { recursive: true });
  const id = `${meetingKey(meetingId)}_${Date.now()}`;
  fs.writeFileSync(path.join(DIR, `${id}.pdf`), pdf);

  log.action("document stored", { meetingId, id, name: display, bytes: pdf.length });
  return { id, url: `/documents/${id}.pdf`, name: display };
}

/** The meeting a stored file belongs to, which is the first part of its name. */
function meetingKey(meetingId) {
  return (
    String(meetingId || "meeting")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 48) || "meeting"
  );
}

/** Everything this meeting opened, gone the moment the meeting is. */
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
        log.error("could not remove a document", { name, error: err.message });
      }
    }
    if (removed) log.info("documents removed with the meeting", { meetingId, removed });
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
        log.error("could not remove an old document", { name, error: err.message });
      }
    }
    if (removed) log.info("old documents removed", { removed });
    return removed;
  } catch (err) {
    log.error("document sweep failed", err);
    return 0;
  }
}

module.exports = {
  DIR,
  MAX_BYTES,
  save,
  sweep,
  removeForMeeting,
  safeId,
  cleanName,
  looksLikePdf,
  findConverter,
  canConvertWord: () => Boolean(findConverter()),
};
