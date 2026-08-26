const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("Attendance");

const ATTENDANCE_DIR = process.env.ATTENDANCE_DIR
  ? path.resolve(process.env.ATTENDANCE_DIR)
  : path.join(__dirname, "..", "..", "attendance");

/**
 * meetingId arrives from the client, so it must never reach the filesystem raw.
 * Anything outside [A-Za-z0-9_-] collapses to "_".
 */
function safeId(meetingId) {
  return String(meetingId || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64) || "unknown";
}

function fileFor(meetingId) {
  return path.join(ATTENDANCE_DIR, `${safeId(meetingId)}.jsonl`);
}

/**
 * Append-only so a crash mid-meeting still leaves every earlier event intact.
 * Attendance is never derived from in-memory state alone.
 */
function recordEvent(meetingId, event) {
  try {
    fs.mkdirSync(ATTENDANCE_DIR, { recursive: true });
    const row = {
      at: Date.now(),
      ...event,
      meetingId: String(meetingId || "unknown"),
    };
    fs.appendFileSync(fileFor(meetingId), `${JSON.stringify(row)}\n`, "utf8");
    log.info("event", { meetingId, type: row.type, name: row.name, reason: row.reason });
    return row;
  } catch (err) {
    log.error("recordEvent failed", err);
    return null;
  }
}

function recordJoin(meetingId, peer, reason = "join") {
  return recordEvent(meetingId, {
    type: "join",
    peerId: peer.id,
    name: peer.name,
    role: peer.role,
    reason,
  });
}

function recordLeave(meetingId, peer, reason = "left") {
  return recordEvent(meetingId, {
    type: "leave",
    peerId: peer.id,
    name: peer.name,
    role: peer.role,
    reason,
  });
}

function readEvents(meetingId) {
  try {
    const file = fileFor(meetingId);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          // A torn final line (killed mid-write) must not sink the whole report.
          log.warn("skipping unparseable attendance line");
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
  } catch (err) {
    log.error("readEvents failed", err);
    return [];
  }
}

function listMeetings() {
  try {
    if (!fs.existsSync(ATTENDANCE_DIR)) return [];
    return fs
      .readdirSync(ATTENDANCE_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const meetingId = f.replace(/\.jsonl$/, "");
        const stat = fs.statSync(path.join(ATTENDANCE_DIR, f));
        // Counting distinct name+role is cheaper than folding full sessions,
        // and the dropdown only needs a headline figure.
        const events = readEvents(meetingId);
        const people = new Set(
          events.map((e) => `${String(e.name || "").trim().toLowerCase()}::${e.role}`),
        );
        const startedAt = events.length ? events[0].at : null;
        return {
          meetingId,
          updatedAt: stat.mtimeMs,
          bytes: stat.size,
          startedAt,
          dateLabel: startedAt == null ? "" : istDate(startedAt),
          startedLabel: startedAt == null ? "" : istTime(startedAt),
          weekday: startedAt == null ? "" : istWeekday(startedAt),
          peopleCount: people.size,
        };
      })
      .sort((a, b) => (b.startedAt || b.updatedAt) - (a.startedAt || a.updatedAt));
  } catch (err) {
    log.error("listMeetings failed", err);
    return [];
  }
}

/**
 * Folds the event stream into one row per person.
 *
 * Keyed by name+role, not peerId: a reconnect (or a plain rejoin) mints a fresh
 * peerId, and a teacher who drops twice should still read as one person with
 * three sessions rather than three people. There are no user accounts in this
 * app, so a display name is the only stable identity available -- two students
 * typing the same name will merge, which is why sessionCount is reported.
 *
 * An unclosed session means the person is still in the meeting; its duration is
 * measured to `now` so a live view keeps ticking.
 */
function buildReport(meetingId, { now = Date.now() } = {}) {
  const events = readEvents(meetingId);
  const byPerson = new Map();

  const keyOf = (e) => `${String(e.name || "").trim().toLowerCase()}::${e.role}`;

  for (const e of events) {
    const key = keyOf(e);
    if (!byPerson.has(key)) {
      byPerson.set(key, {
        name: String(e.name || "").trim() || "(unnamed)",
        role: e.role || "student",
        sessions: [],
      });
    }
    const person = byPerson.get(key);
    const open = person.sessions.find((s) => s.leftAt == null);

    if (e.type === "join") {
      // A join with a session already open means we never saw the leave
      // (hard kill, lost socket). Close it at the join rather than nesting.
      if (open) {
        open.leftAt = e.at;
        open.durationMs = Math.max(0, e.at - open.joinedAt);
        open.reason = "assumed-dropped";
      }
      person.sessions.push({
        joinedAt: e.at,
        leftAt: null,
        durationMs: null,
        reason: e.reason || "join",
      });
    } else if (e.type === "leave") {
      // A leave with nothing open is a duplicate (e.g. disconnect racing a
      // session close) and is ignored rather than inventing a session.
      if (open) {
        open.leftAt = e.at;
        open.durationMs = Math.max(0, e.at - open.joinedAt);
        open.reason = e.reason || "left";
      }
    }
  }

  // The meeting's own calendar date. Rows carry a date only when they differ
  // from it, which keeps the table narrow but stays unambiguous across midnight.
  const meetingStartedAt = events.length ? events[0].at : null;
  const meetingDate = meetingStartedAt != null ? istDate(meetingStartedAt) : "";
  const dateNote = (ms) => {
    if (ms == null) return null;
    const d = istDate(ms);
    return d === meetingDate ? null : d;
  };

  const people = [...byPerson.values()].map((p) => {
    const totalMs = p.sessions.reduce(
      (sum, s) => sum + (s.durationMs != null ? s.durationMs : Math.max(0, now - s.joinedAt)),
      0,
    );
    const present = p.sessions.some((s) => s.leftAt == null);
    const leaves = p.sessions.filter((s) => s.leftAt != null);
    const firstJoinAt = p.sessions.length ? p.sessions[0].joinedAt : null;
    const lastLeaveAt = leaves.length ? leaves[leaves.length - 1].leftAt : null;
    return {
      name: p.name,
      role: p.role,
      sessionCount: p.sessions.length,
      sessions: p.sessions.map((s) => ({
        ...s,
        joinedLabel: istTime(s.joinedAt),
        joinedDateNote: dateNote(s.joinedAt),
        leftLabel: s.leftAt == null ? null : istTime(s.leftAt),
        leftDateNote: dateNote(s.leftAt),
        durationLabel: s.durationMs == null ? null : durationLabel(s.durationMs),
      })),
      firstJoinAt,
      lastLeaveAt,
      totalMs,
      present,
      // Pre-formatted so the panel and the CSV read the same source.
      firstJoinLabel: istTime(firstJoinAt),
      firstJoinDateNote: dateNote(firstJoinAt),
      lastLeaveLabel: istTime(lastLeaveAt),
      lastLeaveDateNote: dateNote(lastLeaveAt),
      durationLabel: durationLabel(totalMs),
      durationMinutes: minutes(totalMs),
    };
  });

  const rank = { teacher: 0, coordinator: 1, student: 2 };
  people.sort(
    (a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || (a.firstJoinAt || 0) - (b.firstJoinAt || 0),
  );

  // Meeting end = the latest departure, but only once nobody is still present.
  const anyPresent = people.some((p) => p.present);
  const endedAt = anyPresent
    ? null
    : people.reduce((max, p) => (p.lastLeaveAt && p.lastLeaveAt > max ? p.lastLeaveAt : max), 0) || null;

  return {
    meetingId: String(meetingId),
    generatedAt: now,
    eventCount: events.length,
    startedAt: meetingStartedAt,
    endedAt,
    timezone: TIMEZONE,
    timezoneLabel: TZ_LABEL,
    meetingDate,
    meetingWeekday: meetingStartedAt != null ? istWeekday(meetingStartedAt) : "",
    startedLabel: istTime(meetingStartedAt),
    endedLabel: endedAt == null ? null : istTime(endedAt),
    generatedLabel: istDateTime(now),
    people,
    totals: {
      people: people.length,
      present: people.filter((p) => p.present).length,
      students: people.filter((p) => p.role === "student").length,
    },
  };
}

const TIMEZONE = process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";
const TZ_LABEL = process.env.ATTENDANCE_TZ_LABEL || "IST";

/**
 * Timestamps are stored as epoch milliseconds, which carry no timezone, so all
 * of this is presentation only -- logs written before this existed still render
 * correctly.
 *
 * Built from formatToParts rather than a locale string: en-GB yields lowercase
 * "pm" and slashes, en-US yields a different date order. Composing the parts
 * ourselves pins the output to exactly one format regardless of the host locale
 * or Node's ICU build.
 */
function istParts(ms) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    weekday: "long",
  });
  const out = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** 26-08-2026 */
function istDate(ms) {
  if (ms == null) return "";
  const p = istParts(ms);
  return `${p.day}-${p.month}-${p.year}`;
}

/** 01:14 AM */
function istTime(ms) {
  if (ms == null) return "";
  const p = istParts(ms);
  return `${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}`;
}

/** 26-08-2026, 01:14 AM */
function istDateTime(ms) {
  if (ms == null) return "";
  return `${istDate(ms)}, ${istTime(ms)}`;
}

/** Wednesday */
function istWeekday(ms) {
  return ms == null ? "" : istParts(ms).weekday;
}

/** 1h 25m — or 45m under the hour, 0m when there is nothing to show. */
function durationLabel(ms) {
  const mins = Math.round(Math.max(0, ms || 0) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function minutes(ms) {
  return Math.round(Math.max(0, ms || 0) / 60000);
}

function hhmmss(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function csvCell(value) {
  const s = String(value ?? "");
  // Guard both CSV quoting and spreadsheet formula injection via a leading =/+/-/@.
  const escaped = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}

/**
 * Meeting ID and date repeat on every row rather than sitting in a preamble:
 * a header block above the columns would break any spreadsheet or script that
 * parses this as plain CSV.
 */
function toCsv(report) {
  const tz = report.timezoneLabel || TZ_LABEL;
  const header = [
    "Meeting ID",
    "Date",
    "Name",
    "Role",
    `In (${tz})`,
    `Out (${tz})`,
    "Duration",
    "Minutes",
    "Sessions",
    "Status",
  ];
  const rows = report.people.map((p) => [
    report.meetingId,
    // A row spanning midnight carries its own date so the export stays exact.
    p.firstJoinDateNote || report.meetingDate,
    p.name,
    p.role,
    p.firstJoinLabel || "",
    p.present ? "still in meeting" : p.lastLeaveLabel || "",
    p.durationLabel,
    p.durationMinutes,
    p.sessionCount,
    p.present ? "In meeting" : "Left",
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

module.exports = {
  ATTENDANCE_DIR,
  TIMEZONE,
  TZ_LABEL,
  safeId,
  recordEvent,
  recordJoin,
  recordLeave,
  readEvents,
  listMeetings,
  buildReport,
  toCsv,
  hhmmss,
  istDate,
  istTime,
  istDateTime,
  istWeekday,
  durationLabel,
  minutes,
};
