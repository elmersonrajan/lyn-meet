const fs = require("fs");
const path = require("path");

/**
 * Recording file names: <meetingId>_<DDMMMYY>.mp4, e.g. 10maths_27AUG26.mp4
 *
 * Pure apart from the collision check, which is injectable, so the naming rules
 * are testable without touching a disk.
 */

const TIMEZONE = process.env.RECORDING_TIMEZONE || "Asia/Kolkata";
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * The meeting ID reaches the filesystem, and it comes from a browser, so it is
 * never used as typed. Same rule as the attendance log.
 */
function safeMeetingId(meetingId) {
  return (
    String(meetingId || "meeting")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 48) || "meeting"
  );
}

/** 27AUG26 in the recording timezone, so the date matches the local class day. */
function dateStamp(at = Date.now(), timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const month = MONTHS[Number(get("month")) - 1] || "XXX";
  return `${get("day")}${month}${get("year")}`;
}

/**
 * Builds the output name, adding _2, _3 ... when a recording for that meeting
 * already exists on the same day rather than overwriting the earlier one.
 *
 * @param {string} meetingId
 * @param {{at?:number, exists?:(name:string)=>boolean, timeZone?:string, max?:number}} opts
 */
function recordingFileName(meetingId, opts = {}) {
  const { at = Date.now(), exists = () => false, timeZone = TIMEZONE, max = 99 } = opts;
  const base = `${safeMeetingId(meetingId)}_${dateStamp(at, timeZone)}`;
  if (!exists(`${base}.mp4`)) return `${base}.mp4`;
  for (let n = 2; n <= max; n += 1) {
    const candidate = `${base}_${n}.mp4`;
    if (!exists(candidate)) return candidate;
  }
  // Beyond the cap, fall back to something guaranteed unique rather than
  // silently overwriting a class recording.
  return `${base}_${at}.mp4`;
}

/** Convenience wrapper that checks a real directory. */
function resolveOutputPath(dir, meetingId, at = Date.now()) {
  const name = recordingFileName(meetingId, {
    at,
    exists: (candidate) => {
      try {
        return fs.existsSync(path.join(dir, candidate));
      } catch {
        return false;
      }
    },
  });
  return { name, fullPath: path.join(dir, name) };
}

module.exports = { safeMeetingId, dateStamp, recordingFileName, resolveOutputPath, TIMEZONE };
