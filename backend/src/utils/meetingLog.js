const fs = require("fs");
const path = require("path");

const LOG_PATH = path.resolve(__dirname, "../../logs/last-meeting.log");

function ensure() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  } catch (err) {
    console.error("[MeetingLog] ensure dir failed", err);
  }
}

function resetMeetingLog(meta = {}) {
  try {
    ensure();
    const line = `[${new Date().toISOString()}] NEW MEETING ${JSON.stringify(meta)}\n`;
    fs.writeFileSync(LOG_PATH, line, "utf8");
    console.log("[MeetingLog] reset", LOG_PATH);
  } catch (err) {
    console.error("[MeetingLog] reset failed", err);
  }
}

function appendMeetingLog(message, extra) {
  try {
    ensure();
    const line = extra
      ? `[${new Date().toISOString()}] ${message} ${JSON.stringify(extra)}\n`
      : `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch (err) {
    console.error("[MeetingLog] append failed", err);
  }
}

module.exports = { resetMeetingLog, appendMeetingLog, LOG_PATH };
