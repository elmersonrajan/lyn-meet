/**
 * The database mirror of the attendance log.
 *
 * The `.jsonl` file stays the record. It is written synchronously, it survives
 * a crash mid-class, and every duration in the app is still derived from it.
 * This module is a *projection* of that file into the four tables lynindia.in
 * already reads, so attendance taken in a meeting appears on the platform
 * without anybody exporting a spreadsheet:
 *
 *   AttendanceLog      one row per period of presence -- in, out, session
 *   Attendance         one row per student per class-day (the register)
 *   TeacherAttendance  the same, for the teacher who took the class
 *   AdminAttendance    the same, for a coordinator supervising it
 *
 * Why a projection and not the source of truth: a network blip between this
 * server and MySQL must not be able to lose a student's attendance. Every
 * write here may fail, and when it does the events are still on disk and can
 * be replayed with `scripts/backfill-attendance.js`.
 *
 * The shapes are the platform's, not ours. Times are strings like "6:59 PM",
 * durations read "1 hr 5 min", and both are in the class's own timezone --
 * matching what the existing 14,605 rows look like, because a row that needs
 * special handling on the site is a row that will be handled wrongly.
 */
const attendanceLog = require("./attendanceLog");
const { getPool, query } = require("../db/pool");
const { createLogger } = require("../utils/logger");

const log = createLogger("AttendanceDB");

const TIMEZONE = attendanceLog.TIMEZONE;

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

const config = {
  /** The single switch that stops this server writing to the platform tables. */
  get enabled() {
    return flag("ATTENDANCE_DB_WRITES", true);
  },
  /**
   * Stamped on every register row this server writes, and the reason it can
   * safely rewrite its own rows: the upsert only overwrites a row carrying
   * this same marker, so attendance uploaded by a centre or by the site itself
   * is never silently replaced by ours.
   */
  get uploadedBy() {
    return process.env.ATTENDANCE_UPLOADED_BY || "LYN MEET";
  },
};

/** Rooms are ClassSchedule.ScheduleID. An ad-hoc test room has nothing to write to. */
function scheduleIdOf(meetingId) {
  const id = String(meetingId || "").trim();
  return /^[0-9]{1,10}$/.test(id) ? Number(id) : null;
}

// ---------------------------------------------------------------------------
// The platform's formats
// ---------------------------------------------------------------------------

function parts(ms, options) {
  const out = {};
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, ...options });
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** "6:59 PM" -- no leading zero on the hour, which is how the site stores it. */
function clockTime(ms) {
  if (ms == null) return "";
  const p = parts(ms, { hour: "numeric", minute: "2-digit", hour12: true });
  return `${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}`;
}

/** "2026-09-05 18:59:03" in the class's timezone, for a DATETIME column. */
function stamp(ms) {
  const p = parts(ms, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  // Some ICU builds still render midnight as "24" under h23.
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`;
}

/**
 * "1 hr 5 min", "45 min", "12 sec" -- the exact vocabulary already in the
 * `duration` column, seconds included, for someone who looked in and left.
 */
function durationText(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

/**
 * `Attendance.duration` is varchar(11), which "12 hr 30 min" overflows and
 * strict mode then rejects outright. A marathon meeting is not worth losing
 * the row over, so it degrades to plain minutes rather than being truncated.
 */
function fitDuration(ms, max) {
  const text = durationText(ms);
  if (text.length <= max) return text;
  const minutes = `${Math.floor(Math.max(0, ms || 0) / 60000)} min`;
  return minutes.length <= max ? minutes : minutes.slice(0, max);
}

// ---------------------------------------------------------------------------
// What a room is
// ---------------------------------------------------------------------------

const CONTEXT_TTL_MS = 5 * 60 * 1000;
const contexts = new Map();

/**
 * Everything the register needs about the class behind a room, resolved once
 * and cached: it is asked on every join and every leave, and it cannot change
 * while a class is running.
 *
 * `Subject`, `Class` and `Medium` are read from ClassSubject rather than taken
 * from anywhere else -- every existing row agrees with it, so deriving them
 * the same way keeps ours indistinguishable from the site's own.
 */
async function meetingContext(meetingId) {
  const scheduleId = scheduleIdOf(meetingId);
  if (scheduleId == null) return null;

  const cached = contexts.get(scheduleId);
  if (cached && Date.now() - cached.at < CONTEXT_TTL_MS) return cached.value;

  const rows = await query(
    `SELECT cs.ScheduleID     AS scheduleId,
            cs.ScheduleDate   AS attendDate,
            cs.ClassSubjectID AS classSubjectId,
            csub.SubjectID    AS subjectId,
            csub.ClassID      AS classId,
            csub.Medium       AS medium
       FROM ClassSchedule cs
       LEFT JOIN ClassSubject csub ON csub.ClassSubjectID = cs.ClassSubjectID
      WHERE cs.ScheduleID = ?
      LIMIT 1`,
    [scheduleId],
  );
  const value = rows.length ? rows[0] : null;
  contexts.set(scheduleId, { at: Date.now(), value });
  if (!value) log.warn("no such schedule — nothing to attach attendance to", { scheduleId });
  return value;
}

// ---------------------------------------------------------------------------
// AttendanceLog: one row per period of presence
// ---------------------------------------------------------------------------

/**
 * `LogID` carries no AUTO_INCREMENT, so the id has to be chosen here.
 *
 * MAX+1 is read inside the same transaction that inserts, under FOR UPDATE, so
 * two people joining at the same instant cannot both pick the same number.
 * Should they race anyway, the duplicate-key error is retried rather than
 * losing the row. Adding AUTO_INCREMENT to the column later changes nothing
 * here -- an explicit id stays legal.
 */
async function openLogRow({ email, at, scheduleId, attempt = 0 }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "SELECT COALESCE(MAX(LogID), 0) + 1 AS id FROM AttendanceLog FOR UPDATE",
    );
    const logId = Number(rows[0].id);
    await conn.execute(
      `INSERT INTO AttendanceLog (LogID, EmailID, InTime, OutTime, SessionID)
       VALUES (?, ?, ?, NULL, ?)`,
      [logId, email, stamp(at), scheduleId],
    );
    await conn.commit();
    return logId;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // A rollback failing on a dead connection is not the error worth reporting.
    }
    if (err.code === "ER_DUP_ENTRY" && attempt < 3) {
      return openLogRow({ email, at, scheduleId, attempt: attempt + 1 });
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Closes the period of presence.
 *
 * Normally the LogID is remembered from the join. When it is not -- the server
 * restarted mid-class, or the join write failed -- the person's most recent
 * open row for this class is closed instead, which is the only row it could
 * be.
 */
async function closeLogRow({ logId, email, scheduleId, at }) {
  const outTime = stamp(at);
  if (logId != null) {
    const result = await query(
      "UPDATE AttendanceLog SET OutTime = ? WHERE LogID = ? AND OutTime IS NULL",
      [outTime, logId],
    );
    if (result.affectedRows > 0) return true;
  }
  const open = await query(
    `SELECT LogID FROM AttendanceLog
      WHERE EmailID = ? AND SessionID = ? AND OutTime IS NULL
      ORDER BY LogID DESC LIMIT 1`,
    [email, scheduleId],
  );
  if (!open.length) return false;
  await query("UPDATE AttendanceLog SET OutTime = ? WHERE LogID = ?", [outTime, open[0].LogID]);
  return true;
}

// ---------------------------------------------------------------------------
// The registers: one row per person per class
// ---------------------------------------------------------------------------

/**
 * A student's row in the class register.
 *
 * The upsert only overwrites a row this server wrote itself. Attendance for
 * the same student, day, subject and class may already have been uploaded by a
 * centre -- that is a human's decision about a real class, and a meeting that
 * happens to carry the same ScheduleID must not quietly replace it.
 */
async function upsertStudent({ email, ctx, totalMs, firstJoinAt, lastLeaveAt }) {
  if (ctx.subjectId == null || ctx.classId == null) {
    log.warn("schedule has no subject or class — skipping the register row", {
      scheduleId: ctx.scheduleId,
      email,
    });
    return false;
  }
  await query(
    `INSERT INTO Attendance
        (emailid, AttendDate, Subject, Class, duration, TimeJoined, Timeleft,
         Medium, ClassSubjectID, ScheduleID, UploadedBy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE
        duration       = IF(Attendance.UploadedBy = incoming.UploadedBy, incoming.duration, Attendance.duration),
        TimeJoined     = IF(Attendance.UploadedBy = incoming.UploadedBy, incoming.TimeJoined, Attendance.TimeJoined),
        Timeleft       = IF(Attendance.UploadedBy = incoming.UploadedBy, incoming.Timeleft, Attendance.Timeleft),
        Medium         = IF(Attendance.UploadedBy = incoming.UploadedBy, incoming.Medium, Attendance.Medium),
        ClassSubjectID = IF(Attendance.UploadedBy = incoming.UploadedBy, incoming.ClassSubjectID, Attendance.ClassSubjectID),
        ScheduleID     = IF(Attendance.UploadedBy = incoming.UploadedBy, incoming.ScheduleID, Attendance.ScheduleID)`,
    [
      email,
      ctx.attendDate,
      ctx.subjectId,
      ctx.classId,
      fitDuration(totalMs, 11),
      clockTime(firstJoinAt),
      clockTime(lastLeaveAt),
      ctx.medium || "",
      ctx.classSubjectId,
      ctx.scheduleId,
      config.uploadedBy,
    ],
  );
  return true;
}

/**
 * Staff rows carry no class of their own, only the schedule they were in.
 *
 * Neither table has a unique key, so the existing row is found first and
 * updated in place. Inserting blindly would leave a class holding six rows for
 * one teacher who reconnected five times, which is exactly what the imported
 * history looks like.
 */
async function upsertStaff({
  table,
  idColumn,
  emailColumn,
  email,
  ctx,
  totalMs,
  firstJoinAt,
  lastLeaveAt,
}) {
  const values = [clockTime(firstJoinAt), clockTime(lastLeaveAt), fitDuration(totalMs, 300)];
  const existing = await query(
    `SELECT ${idColumn} AS id FROM ${table}
      WHERE ${emailColumn} = ? AND ScheduleID = ?
      ORDER BY ${idColumn} DESC LIMIT 1`,
    [email, ctx.scheduleId],
  );
  if (existing.length) {
    await query(
      `UPDATE ${table} SET TimeJoined = ?, TimeLeft = ?, Duration = ? WHERE ${idColumn} = ?`,
      [...values, existing[0].id],
    );
    return true;
  }
  await query(
    `INSERT INTO ${table} (${emailColumn}, TimeJoined, TimeLeft, Duration, ScheduleID)
     VALUES (?, ?, ?, ?, ?)`,
    [email, ...values, ctx.scheduleId],
  );
  return true;
}

/**
 * Which register a person belongs in. The platform keeps one table per
 * population, and a teacher has no Class or Subject to file a student row
 * under, so this is the platform's split rather than a choice made here.
 */
const STAFF_TABLES = {
  teacher: { table: "TeacherAttendance", idColumn: "TeachAttendID", emailColumn: "EmailID" },
  coordinator: {
    table: "AdminAttendance",
    idColumn: "AdminAttendanceID",
    emailColumn: "AdminEmailID",
  },
};

/**
 * Writes one person's register row for one class-day.
 *
 * The numbers are never computed here. `buildReport` already knows how to pair
 * joins with leaves, how to refuse to credit time spent disconnected, and what
 * to do with a session whose exit was never recorded -- so the register says
 * exactly what the Attendance panel says, down to the minute.
 */
async function writeRegisterRow({ meetingId, email, role, dayKey, ctx }) {
  const report = attendanceLog.buildReport(meetingId, { date: dayKey });
  const person = report.people.find((p) => p.email === email);
  if (!person) return false;

  const row = {
    email,
    ctx,
    totalMs: person.totalMs,
    firstJoinAt: person.firstJoinAt,
    lastLeaveAt: person.lastLeaveAt,
  };
  const staff = STAFF_TABLES[role];
  return staff ? upsertStaff({ ...staff, ...row }) : upsertStudent(row);
}

// ---------------------------------------------------------------------------
// Following the log
// ---------------------------------------------------------------------------

/** peer -> the AttendanceLog row opened for their current period of presence. */
const openRows = new Map();
const keyFor = (row) => `${row.meetingId}::${row.peerId}`;

/**
 * Every write goes through one queue, in the order the events happened.
 *
 * A leave arriving while its own join is still in flight would otherwise find
 * no open row to close, and a student who rejoins quickly would race their own
 * departure. The volume is a handful of statements per person per class, so
 * serialising costs nothing worth measuring.
 */
let chain = Promise.resolve();
let pending = 0;
const MAX_PENDING = 500;

function enqueue(task, describe) {
  if (pending >= MAX_PENDING) {
    // The database is unreachable or hopelessly behind. The file still holds
    // every event, so this is recoverable with the backfill script -- growing
    // the queue without limit is not.
    log.error("attendance write queue is full — dropping the mirror write", describe);
    return;
  }
  pending += 1;
  chain = chain
    .then(task)
    .catch((err) => {
      log.error("attendance mirror write failed", { ...describe, error: err.message });
    })
    .finally(() => {
      pending -= 1;
    });
}

async function handleJoin(row) {
  const ctx = await meetingContext(row.meetingId);
  if (!ctx) return;
  const logId = await openLogRow({ email: row.email, at: row.at, scheduleId: ctx.scheduleId });
  openRows.set(keyFor(row), { logId, joinedAt: row.at });
  log.info("session opened", { logId, email: row.email, scheduleId: ctx.scheduleId });
}

async function handleLeave(row) {
  const ctx = await meetingContext(row.meetingId);
  if (!ctx) return;
  const key = keyFor(row);
  const open = openRows.get(key);
  openRows.delete(key);

  await closeLogRow({
    logId: open ? open.logId : null,
    email: row.email,
    scheduleId: ctx.scheduleId,
    at: row.at,
  });

  // The register is rebuilt for the day this period of presence STARTED: a
  // class running past midnight belongs to the day it began, which is the rule
  // the report and the CSV already follow.
  const dayKey = attendanceLog.istDate(open ? open.joinedAt : row.at);
  const written = await writeRegisterRow({
    meetingId: row.meetingId,
    email: row.email,
    role: row.role,
    dayKey,
    ctx,
  });
  log.info("register updated", { email: row.email, scheduleId: ctx.scheduleId, written });
}

/**
 * Attendance events, as they are written to the file.
 *
 * A row with no account behind it (local development with auth disabled) is
 * ignored: every one of these tables is keyed by email address, so there would
 * be nothing to key it on.
 */
function handleEvent(row) {
  if (!config.enabled || !row || !row.email) return;
  if (scheduleIdOf(row.meetingId) == null) return;
  const describe = { meetingId: row.meetingId, email: row.email, type: row.type };
  if (row.type === "join") enqueue(() => handleJoin(row), describe);
  else if (row.type === "leave") enqueue(() => handleLeave(row), describe);
}

/**
 * Closes periods of presence that a hard kill left open.
 *
 * The server restarting means nobody is still in a meeting, so a row without
 * an OutTime is stale by definition. The end is taken from the file using the
 * same rule as the report -- the last thing the meeting actually witnessed,
 * never the current time. That mistake is what once turned seven minutes of
 * class into four hours and forty-eight minutes.
 */
async function closeAbandonedRows({ limit = 500 } = {}) {
  // Inlined rather than bound: a prepared statement will not take a parameter
  // in LIMIT. Forced through Number so it can only ever be a number.
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 500;
  const open = await query(
    `SELECT LogID, EmailID, InTime, SessionID FROM AttendanceLog
      WHERE OutTime IS NULL ORDER BY LogID DESC LIMIT ${cap}`,
  );
  let closed = 0;
  for (const row of open) {
    const events = attendanceLog.readEvents(String(row.SessionID));
    if (!events.length) continue;
    const lastWitnessed = events[events.length - 1].at;
    const email = String(row.EmailID || "").toLowerCase();
    const person = attendanceLog.foldSessions(events).get(`email::${email}`);
    // Match the stored InTime back to the session it came from, so the right
    // one of several is the one that gets closed.
    const inTime = stamp(new Date(String(row.InTime).replace(" ", "T")).getTime());
    const session = person ? person.sessions.find((s) => stamp(s.joinedAt) === inTime) : null;
    const endedAt = session && session.leftAt != null ? session.leftAt : lastWitnessed;
    await query("UPDATE AttendanceLog SET OutTime = ? WHERE LogID = ? AND OutTime IS NULL", [
      stamp(endedAt),
      row.LogID,
    ]);
    closed += 1;
  }
  if (closed) log.warn("closed periods of presence left open by a restart", { closed });
  return closed;
}

/**
 * Replays a meeting-day from the file into the registers.
 *
 * This is the answer to every "the database was down" question: the file holds
 * the events, so the register can always be rebuilt from it.
 */
async function backfill(meetingId, { date } = {}) {
  const ctx = await meetingContext(meetingId);
  if (!ctx) throw new Error(`${meetingId} is not a scheduled class`);
  const report = attendanceLog.buildReport(meetingId, { date });
  const written = [];
  for (const person of report.people) {
    if (!person.email) continue;
    const staff = STAFF_TABLES[person.role];
    const row = {
      email: person.email,
      ctx,
      totalMs: person.totalMs,
      firstJoinAt: person.firstJoinAt,
      lastLeaveAt: person.lastLeaveAt,
    };
    const ok = staff ? await upsertStaff({ ...staff, ...row }) : await upsertStudent(row);
    if (ok) {
      written.push({
        email: person.email,
        role: person.role,
        duration: durationText(person.totalMs),
      });
    }
  }
  return { meetingDate: report.meetingDate, scheduleId: ctx.scheduleId, written };
}

let started = false;

/** Subscribes to the attendance log. Called once, at boot. */
function start() {
  if (started) return false;
  if (!config.enabled) {
    log.warn("attendance database writes are OFF (ATTENDANCE_DB_WRITES=0)");
    return false;
  }
  if (!process.env.DB_HOST) {
    log.warn("no DB_HOST — attendance stays in the file only");
    return false;
  }
  attendanceLog.onEvent(handleEvent);
  started = true;
  log.info("mirroring attendance to the platform database", { uploadedBy: config.uploadedBy });
  closeAbandonedRows().catch((err) => log.error("could not close abandoned rows", err.message));
  return true;
}

/** Lets the process exit knowing the last leave of the class was written. */
async function flush() {
  await chain;
}

module.exports = {
  start,
  flush,
  backfill,
  closeAbandonedRows,
  handleEvent,
  config,
  // Exported for the tests: these are the formats the platform expects, and
  // getting one wrong is a row nobody notices is wrong.
  clockTime,
  stamp,
  durationText,
  fitDuration,
  scheduleIdOf,
};
