const fs = require("fs");
const path = require("path");

const LOG_PATH = path.resolve(__dirname, "../../logs/last-meeting.log");
let teed = false;
let writing = false;

function ensure() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  } catch (err) {
    process.stderr.write(`[MeetingLog] ensure failed ${err}\n`);
  }
}

function dump(value) {
  try {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "undefined") return null;
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length };
    if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", bytes: value.byteLength };
    return JSON.parse(
      JSON.stringify(value, (key, val) => {
        if (typeof val === "bigint") return String(val);
        if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
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
  if (writing) return;
  writing = true;
  try {
    ensure();
    const row = {
      t: new Date().toISOString(),
      message,
      extra: extra === undefined ? null : dump(extra),
    };
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`[MeetingLog] append failed ${err}\n`);
  } finally {
    writing = false;
  }
}

function resetMeetingLog(meta = {}) {
  try {
    ensure();
    const header = `${JSON.stringify({
      t: new Date().toISOString(),
      message: "NEW MEETING — full log (overwrites previous meeting)",
      extra: dump(meta),
    })}\n`;
    fs.writeFileSync(LOG_PATH, header, "utf8");
    process.stdout.write(`[MeetingLog] reset ${LOG_PATH}\n`);
  } catch (err) {
    process.stderr.write(`[MeetingLog] reset failed ${err}\n`);
  }
}

function teeConsoleToMeetingLog() {
  try {
    if (teed) return;
    teed = true;
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: (console.info || console.log).bind(console),
    };
    ["log", "warn", "error", "info"].forEach((level) => {
      console[level] = (...args) => {
        try {
          orig[level](...args);
        } catch (err) {
          process.stderr.write(`[MeetingLog] console ${level} failed ${err}\n`);
        }
        try {
          appendMeetingLog(`console.${level}`, args.map(dump));
        } catch (err) {
          /* ignore */
        }
      };
    });
    appendMeetingLog("console tee enabled — every server log is stored in last-meeting.log");
  } catch (err) {
    process.stderr.write(`[MeetingLog] tee failed ${err}\n`);
  }
}

module.exports = {
  resetMeetingLog,
  appendMeetingLog,
  teeConsoleToMeetingLog,
  LOG_PATH,
};
