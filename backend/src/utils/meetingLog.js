const fs = require("fs");
const path = require("path");

const LOG_PATH = path.resolve(__dirname, "../../logs/last-meeting.log");
let teed = false;
let writing = false;

function ensure() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  } catch (err) {
    process.stderr.write(`[MeetingLog] ensure failed ${String(err)}\n`);
  }
}

function rawWrite(text) {
  if (writing) return;
  writing = true;
  try {
    ensure();
    fs.appendFileSync(LOG_PATH, text, "utf8");
  } catch (err) {
    /* never log to console here */
  } finally {
    writing = false;
  }
}

function dump(value) {
  try {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "undefined") return null;
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length, hexHead: value.slice(0, 32).toString("hex") };
    if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", bytes: value.byteLength };
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(value, (key, val) => {
        if (typeof val === "bigint") return String(val);
        if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
        if (val && typeof val === "object") {
          if (seen.has(val)) return "[Circular]";
          try { seen.add(val); } catch (e) { /* ignore */ }
        }
        return val;
      }),
    );
  } catch (err) {
    try {
      return String(value);
    } catch (e) {
      return "[unserializable]";
    }
  }
}

function appendMeetingLog(message, extra) {
  try {
    const row = {
      t: new Date().toISOString(),
      message,
      extra: extra === undefined ? null : dump(extra),
    };
    rawWrite(`${JSON.stringify(row)}\n`);
  } catch (err) {
    /* ignore */
  }
}

function resetMeetingLog(meta = {}) {
  try {
    ensure();
    const header =
      `${"=".repeat(72)}\n` +
      `FULL MEETING LOG (overwritten each new teacher join)\n` +
      `started ${new Date().toISOString()}\n` +
      `${JSON.stringify(dump(meta), null, 2)}\n` +
      `${"=".repeat(72)}\n`;
    fs.writeFileSync(LOG_PATH, header, "utf8");
    process.stdout.write(`[MeetingLog] reset ${LOG_PATH}\n`);
  } catch (err) {
    process.stderr.write(`[MeetingLog] reset failed ${String(err)}\n`);
  }
}

function teeConsoleToMeetingLog() {
  try {
    if (teed) return;
    teed = true;
    ensure();

    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, enc, cb) => {
      try {
        rawWrite(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      } catch (e) { /* ignore */ }
      return origOut(chunk, enc, cb);
    };
    process.stderr.write = (chunk, enc, cb) => {
      try {
        rawWrite(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      } catch (e) { /* ignore */ }
      return origErr(chunk, enc, cb);
    };

    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: (console.info || console.log).bind(console),
      debug: (console.debug || console.log).bind(console),
    };
    ["log", "warn", "error", "info", "debug"].forEach((level) => {
      console[level] = (...args) => {
        try {
          orig[level](...args);
        } catch (e) { /* ignore */ }
        try {
          appendMeetingLog(`console.${level}`, args.map(dump));
        } catch (e) { /* ignore */ }
      };
    });

    appendMeetingLog("FULL TEE ON — terminal + console + client logs go to last-meeting.log");
  } catch (err) {
    process.stderr.write(`[MeetingLog] tee failed ${String(err)}\n`);
  }
}

module.exports = {
  resetMeetingLog,
  appendMeetingLog,
  teeConsoleToMeetingLog,
  LOG_PATH,
};
