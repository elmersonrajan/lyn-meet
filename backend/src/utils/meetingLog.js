const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");

const log = createLogger("MeetingLog");

const LOG_DIR = path.resolve(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "last-meeting.log");

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    log.error("ensureDir failed", err);
  }
}

function append(line) {
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch (err) {
    log.error("append failed", err);
  }
}

let writing = false;

function writeEntry(message, extra) {
  if (writing) return;
  try {
    writing = true;
    append(JSON.stringify({ t: new Date().toISOString(), message, extra }));
  } catch (err) {
    log.error("writeEntry failed", err);
  } finally {
    writing = false;
  }
}

function reset({ meetingId, teacher, peerId }) {
  try {
    ensureDir();
    const started = new Date().toISOString();
    const header = [
      "========================================================================",
      "FULL MEETING LOG (overwritten each new teacher join)",
      `started ${started}`,
      JSON.stringify({ meetingId, teacher, peerId }, null, 2),
      "========================================================================",
      `[MeetingLog] reset ${LOG_FILE}`,
    ].join("\n");
    fs.writeFileSync(LOG_FILE, `${header}\n`, "utf8");
    writeEntry("join-room", { name: teacher, role: "teacher", meetingId, peerId });
    log.info("reset", LOG_FILE);
  } catch (err) {
    log.error("reset failed", err);
  }
}

function teeConsoleToMeetingLog() {
  try {
    if (console.__meetingLogTee) return;
    console.__meetingLogTee = true;
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    console.log = (...args) => {
      origLog(...args);
      writeEntry("console.log", args);
    };
    console.error = (...args) => {
      origErr(...args);
      writeEntry("console.error", args);
    };
    console.warn = (...args) => {
      origWarn(...args);
      writeEntry("console.warn", args);
    };
  } catch (err) {
    log.error("teeConsoleToMeetingLog failed", err);
  }
}

module.exports = {
  reset,
  writeEntry,
  LOG_FILE,
  teeConsoleToMeetingLog,
};
