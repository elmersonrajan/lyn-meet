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
        return { meetingId, updatedAt: stat.mtimeMs, bytes: stat.size };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
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

  const people = [...byPerson.values()].map((p) => {
    const totalMs = p.sessions.reduce(
      (sum, s) => sum + (s.durationMs != null ? s.durationMs : Math.max(0, now - s.joinedAt)),
      0,
    );
    const present = p.sessions.some((s) => s.leftAt == null);
    const leaves = p.sessions.filter((s) => s.leftAt != null);
    return {
      name: p.name,
      role: p.role,
      sessionCount: p.sessions.length,
      sessions: p.sessions,
      firstJoinAt: p.sessions.length ? p.sessions[0].joinedAt : null,
      lastLeaveAt: leaves.length ? leaves[leaves.length - 1].leftAt : null,
      totalMs,
      present,
    };
  });

  const rank = { teacher: 0, coordinator: 1, student: 2 };
  people.sort(
    (a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || (a.firstJoinAt || 0) - (b.firstJoinAt || 0),
  );

  return {
    meetingId: String(meetingId),
    generatedAt: now,
    eventCount: events.length,
    startedAt: events.length ? events[0].at : null,
    people,
    totals: {
      people: people.length,
      present: people.filter((p) => p.present).length,
      students: people.filter((p) => p.role === "student").length,
    },
  };
}

function hhmmss(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function iso(ms) {
  return ms == null ? "" : new Date(ms).toISOString();
}

function csvCell(value) {
  const s = String(value ?? "");
  // Guard both CSV quoting and spreadsheet formula injection via a leading =/+/-/@.
  const escaped = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}

function toCsv(report) {
  const header = [
    "Name",
    "Role",
    "Sessions",
    "First In",
    "Last Out",
    "Duration (hh:mm:ss)",
    "Duration (minutes)",
    "Still Present",
  ];
  const rows = report.people.map((p) => [
    p.name,
    p.role,
    p.sessionCount,
    iso(p.firstJoinAt),
    iso(p.lastLeaveAt),
    hhmmss(p.totalMs),
    Math.round(p.totalMs / 60000),
    p.present ? "yes" : "no",
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

module.exports = {
  ATTENDANCE_DIR,
  safeId,
  recordEvent,
  recordJoin,
  recordLeave,
  readEvents,
  listMeetings,
  buildReport,
  toCsv,
  hhmmss,
};
