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
    email: peer.email || null,
    name: peer.name,
    role: peer.role,
    reason,
  });
}

function recordLeave(meetingId, peer, reason = "left") {
  return recordEvent(meetingId, {
    type: "leave",
    peerId: peer.id,
    email: peer.email || null,
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
      // One entry per meeting-DAY, not per meeting: a recurring class reuses
      // its meeting ID, and each day is a separate register.
      .flatMap((f) => {
        const meetingId = f.replace(/\.jsonl$/, "");
        const byPerson = foldSessions(readEvents(meetingId));
        const days = new Map();
        for (const p of byPerson.values()) {
          for (const s of p.sessions) {
            const key = istDate(s.joinedAt);
            if (!days.has(key)) days.set(key, { startedAt: s.joinedAt, people: new Set() });
            const d = days.get(key);
            if (s.joinedAt < d.startedAt) d.startedAt = s.joinedAt;
            d.people.add(`${p.name.toLowerCase()}::${p.role}`);
          }
        }
        return [...days.entries()].map(([date, d]) => ({
          meetingId,
          date,
          dateLabel: date,
          startedAt: d.startedAt,
          startedLabel: istTime(d.startedAt),
          weekday: istWeekday(d.startedAt),
          peopleCount: d.people.size,
        }));
      })
      .sort((a, b) => b.startedAt - a.startedAt);
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
/**
 * Folds the raw event stream into sessions per person, across the whole log.
 *
 * Deliberately not filtered by day: a session can open before midnight and
 * close after it, so the fold needs the complete stream to pair joins with
 * leaves correctly. Day selection happens afterwards, in buildReport.
 */
function foldSessions(events) {
  const byPerson = new Map();

  // Since sign-in became compulsory, events carry the authenticated account,
  // which is a far better identity than a typed name: two students called
  // "Priya S" no longer collapse into one row, and a rename mid-term no longer
  // splits one person into two. Logs written before then have no email, so the
  // old name+role key is kept for them -- reports over historical meetings must
  // not change shape retroactively.
  const keyOf = (e) =>
    e.email
      ? `email::${String(e.email).trim().toLowerCase()}`
      : `${String(e.name || "").trim().toLowerCase()}::${e.role}`;

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const key = keyOf(e);
    if (!byPerson.has(key)) {
      byPerson.set(key, {
        name: String(e.name || "").trim() || "(unnamed)",
        email: e.email ? String(e.email).trim().toLowerCase() : null,
        role: e.role || "student",
        sessions: [],
      });
    }
    const person = byPerson.get(key);
    const open = person.sessions.find((s) => s.leftAt == null);

    if (e.type === "join") {
      // A join while a session is still open means no exit was ever recorded
      // -- the server was stopped or killed mid-session.
      //
      // Closing it at THIS join would credit the entire gap in between, which
      // is how a 7-minute presence became 4h 48m. Instead it is cut at the last
      // thing the meeting actually witnessed, so an unprovable session
      // under-counts rather than inventing hours of attendance.
      if (open) {
        const lastWitnessed = i > 0 ? events[i - 1].at : open.joinedAt;
        const end = Math.max(open.joinedAt, Math.min(lastWitnessed, e.at));
        open.leftAt = end;
        open.durationMs = Math.max(0, end - open.joinedAt);
        open.reason = "exit-not-recorded";
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

  return byPerson;
}

/**
 * One report per meeting-day.
 *
 * A meeting ID reused for a recurring class writes into a single log, so
 * without this every day would merge into one row and the durations would add
 * up across dates. Each session is attributed to the calendar day it STARTED,
 * which keeps a class running past midnight whole and counted on its start day.
 *
 * @param {string} meetingId
 * @param {{ now?: number, date?: string }} opts date is DD-MM-YYYY; defaults
 *   to the most recent day present in the log.
 */
function buildReport(meetingId, { now = Date.now(), date } = {}) {
  const events = readEvents(meetingId);
  const byPerson = foldSessions(events);
  const lastEventAt = events.length ? events[events.length - 1].at : null;
  const todayKey = istDate(now);

  // Every day the log has attendance for, most recent first.
  const dayKeys = new Set();
  for (const p of byPerson.values()) {
    for (const s of p.sessions) dayKeys.add(istDate(s.joinedAt));
  }
  const availableDates = [...dayKeys].sort((a, b) => {
    const [da, ma, ya] = a.split("-");
    const [db, mb, yb] = b.split("-");
    return `${yb}${mb}${db}`.localeCompare(`${ya}${ma}${da}`);
  });

  const meetingDate = date || availableDates[0] || (events.length ? istDate(events[0].at) : "");

  const dateNote = (ms) => {
    if (ms == null) return null;
    const d = istDate(ms);
    return d === meetingDate ? null : d;
  };

  const people = [...byPerson.values()].map((p) => {
    // Only sessions that began on the requested day belong to this register.
    const sessions = p.sessions.filter((s) => istDate(s.joinedAt) === meetingDate).map((s) => {
      if (s.leftAt != null) return s;
      // An unclosed session from an earlier day means the server stopped
      // without recording a departure. Measuring it to now would report days
      // of attendance, so it is capped at the last thing the log witnessed.
      if (istDate(s.joinedAt) !== todayKey) {
        const end = lastEventAt != null && lastEventAt > s.joinedAt ? lastEventAt : s.joinedAt;
        return {
          ...s,
          leftAt: end,
          durationMs: Math.max(0, end - s.joinedAt),
          reason: "exit-not-recorded",
        };
      }
      return s;
    });
    return { ...p, sessions };
  })
    // A person with nothing on this day is not part of this day's register.
    .filter((p) => p.sessions.length > 0)
    .map((p) => {
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

  // Start of this day's meeting, not of the whole log.
  const dayStartedAt = people.reduce(
    (min, p) => (p.firstJoinAt != null && (min == null || p.firstJoinAt < min) ? p.firstJoinAt : min),
    null,
  );

  return {
    meetingId: String(meetingId),
    generatedAt: now,
    eventCount: events.length,
    availableDates,
    startedAt: dayStartedAt,
    endedAt,
    timezone: TIMEZONE,
    timezoneLabel: TZ_LABEL,
    meetingDate,
    meetingWeekday: dayStartedAt != null ? istWeekday(dayStartedAt) : "",
    startedLabel: istTime(dayStartedAt),
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

/**
 * The raw .jsonl is written for machines: epoch timestamps, one object per
 * line. This renders the same events as an aligned plain-text log so a human
 * can read what happened without parsing JSON.
 *
 * Read-only and derived on request -- the stored format is untouched.
 */
function toText(meetingId, { date } = {}) {
  const all = readEvents(meetingId);
  const events = date ? all.filter((e) => istDate(e.at) === date) : all;

  const rows = events.map((e) => ({
    date: istDate(e.at),
    time: istTime(e.at),
    what: e.type === "join" ? "JOIN" : "LEAVE",
    name: String(e.name || "(unnamed)"),
    role: String(e.role || ""),
    reason: String(e.reason || ""),
  }));

  const width = (key, min) => Math.max(min, ...rows.map((r) => r[key].length), 0);
  const wName = width("name", 4);
  const wRole = width("role", 4);

  const out = [];
  out.push(`Attendance log — ${meetingId}`);
  out.push(date ? `Day: ${date}` : "All days");
  out.push(`Times: ${TZ_LABEL} (${TIMEZONE})`);
  out.push(`Events: ${rows.length}`);
  out.push("");

  if (!rows.length) {
    out.push("(no events recorded)");
    return `${out.join("\n")}\n`;
  }

  // Repeat the date only when it changes, so a multi-day log stays scannable.
  let lastDate = null;
  for (const r of rows) {
    if (r.date !== lastDate) {
      if (lastDate !== null) out.push("");
      out.push(`${r.date}`);
      out.push("-".repeat(r.date.length));
      lastDate = r.date;
    }
    out.push(
      `  ${r.time}   ${r.what.padEnd(5)}  ${r.name.padEnd(wName)}  ${r.role.padEnd(wRole)}  ${r.reason}`,
    );
  }

  // A short tally so the file answers "who and how long" without the panel.
  // A report covers exactly one day, so an all-days view needs one per day --
  // otherwise the events would list every day while the summary showed one.
  const days = date ? [date] : buildReport(meetingId).availableDates;
  for (const day of days) {
    const report = buildReport(meetingId, { date: day });
    out.push("");
    out.push(days.length > 1 ? `Summary — ${day}` : "Summary");
    out.push("-".repeat(days.length > 1 ? `Summary — ${day}`.length : 7));
    if (!report.people.length) {
      out.push("  (nobody recorded)");
      continue;
    }
    for (const p of report.people) {
      out.push(
        `  ${p.name.padEnd(wName)}  ${p.role.padEnd(wRole)}  ${String(p.durationLabel).padEnd(8)}` +
          `  ${p.sessionCount} session${p.sessionCount === 1 ? "" : "s"}` +
          `${p.present ? "  (still in meeting)" : ""}`,
      );
    }
  }
  return `${out.join("\n")}\n`;
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
  foldSessions,
  buildReport,
  toCsv,
  toText,
  hhmmss,
  istDate,
  istTime,
  istDateTime,
  istWeekday,
  durationLabel,
  minutes,
};
