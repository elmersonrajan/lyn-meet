/**
 * A full account of one recording, written beside the file it produces.
 *
 * The ffmpeg log next to this one records what ffmpeg was asked to do and what
 * it said back. That is the right thing to read when an encode fails, and the
 * wrong thing to read for every other kind of fault -- a voice that never made
 * it in, a board page that did not render, a recording that stopped for a
 * reason nobody chose. None of those are ffmpeg problems and none of them
 * appear there.
 *
 * So this records the lesson as it happened: every stream attached, every
 * person who spoke, every share, and how it ended. One JSON object per line,
 * because a recording is a sequence of events and the questions asked of it
 * afterwards are nearly always "what happened around the time X went wrong".
 *
 * Every entry carries `atMs`, the milliseconds since capture began, as well as
 * the wall clock. Wall clock answers "when", `atMs` answers "where in the
 * file", and it is the second question that gets asked when someone reports
 * that the sound drops out four minutes in.
 *
 * Writing is best-effort and never throws: a recording must not fail because
 * its log could not be written.
 */

const fs = require("fs");
const path = require("path");

const { createLogger } = require("../utils/logger");

const log = createLogger("RecordingLog");

/**
 * A line that would be written thousands of times is not a log, it is a leak.
 * The board is snapshotted once a second, so those are counted and reported
 * once rather than recorded individually.
 */
const MAX_LINES = Number(process.env.RECORDING_LOG_MAX_LINES || 5000);

function safe(value) {
  try {
    // A producer or consumer would serialise to something enormous and useless.
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

class RecordingLog {
  /**
   * @param {string} filePath where to write
   * @param {number} startedAt the capture's own start, for atMs
   */
  constructor(filePath, startedAt = Date.now()) {
    this.filePath = filePath;
    this.startedAt = startedAt;
    this.lines = 0;
    this.dropped = 0;
    /** Running totals, reported at the end rather than line by line. */
    this.counters = new Map();
  }

  /** One event. `data` is anything JSON can carry. */
  note(event, data = {}) {
    try {
      if (this.lines >= MAX_LINES) {
        this.dropped += 1;
        return;
      }
      const now = Date.now();
      const row = {
        at: new Date(now).toISOString(),
        atMs: Math.max(0, now - this.startedAt),
        event,
        ...safe(data),
      };
      fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
      this.lines += 1;
    } catch (err) {
      // Once, not per line: a full disk would otherwise fill the server log too.
      if (!this.warned) {
        this.warned = true;
        log.error("could not write the recording log", err.message);
      }
    }
  }

  /** Something that happens too often to record individually. */
  count(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }

  /** Writes the counters and closes the account. */
  finish(event = "finished", data = {}) {
    const totals = Object.fromEntries(this.counters);
    this.note(event, { ...data, totals, linesDropped: this.dropped || undefined });
  }
}

/**
 * Opens the log for a recording. Returns an object that is safe to call even
 * when the directory could not be created -- the recording matters more.
 */
function open(dir, id, startedAt = Date.now()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return new RecordingLog(path.join(dir, `${id}_events.jsonl`), startedAt);
  } catch (err) {
    log.error("could not open a recording log", err.message);
    return new RecordingLog(path.join(dir, `${id}_events.jsonl`), startedAt);
  }
}

/** Reads one back, newest questions first: used by the API. */
function read(dir, id) {
  const file = path.join(dir, `${id}_events.jsonl`);
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // A torn last line is normal if the process died mid-write.
        return { event: "unreadable", raw: line };
      }
    });
}

/** The same events as something a person can read down. */
function toText(rows) {
  return rows
    .map((r) => {
      const { at, atMs, event, ...rest } = r;
      const when = typeof atMs === "number" ? `+${(atMs / 1000).toFixed(1)}s` : "";
      const detail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      return `${at || ""}  ${when.padStart(9)}  ${String(event).padEnd(18)}${detail}`;
    })
    .join("\n");
}

module.exports = { open, read, toText, RecordingLog, MAX_LINES };
