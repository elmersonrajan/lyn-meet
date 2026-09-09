/**
 * Finished recordings, published to the platform.
 *
 * `YouTubeRecords` is where lynindia.in looks for the video of a class: one
 * row of (ScheduleID, VideoURL), which is how a student who missed Tuesday
 * finds Tuesday. Until now a class recorded here produced an .mp4 that only
 * existed on this server, and somebody had to know it was there.
 *
 * So this listens to the render queue and writes the row the moment the file
 * is finished. It hooks `completed` rather than `stop`: what a teacher stops
 * is the capture, and the file worth linking to does not exist until the
 * background render has laid the class out and closed the .mp4.
 *
 * The URL is this server's own playback address. Rows written by the site
 * carry youtu.be links, and a real upload to YouTube would replace the URL in
 * place -- the row, the ScheduleID and the platform's side of it stay exactly
 * as they are.
 */
const renderQueue = require("./renderQueue");
const { query } = require("../db/pool");
const { stamp } = require("../attendance/attendanceDb");
const { createLogger } = require("../utils/logger");

const log = createLogger("Recordings");

/** Ours, in a table the site also writes to. Same marker the attendance rows carry. */
const UPLOADED_BY = process.env.ATTENDANCE_UPLOADED_BY || "LYN MEET";

/**
 * How often to retry rows that could not be written.
 *
 * The live listener fires once, and a database that was unreachable at that
 * moment loses the link for good -- the file is on disk, rendered, with
 * nothing on the platform pointing at it. Publishing is idempotent, so
 * re-checking costs one query per finished recording.
 */
const SWEEP_MINUTES = Number(process.env.RECORDING_SWEEP_MINUTES || 15);

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

const config = {
  get enabled() {
    return flag("RECORDING_DB_WRITES", true);
  },
  /**
   * Where these files are reachable from outside this box. Falls back to the
   * audience the SSO tickets are minted for, which is by definition this
   * server's public origin.
   */
  get baseUrl() {
    const base = process.env.RECORDING_PUBLIC_BASE_URL || process.env.SSO_AUDIENCE || "";
    return base.replace(/\/+$/, "");
  },
};

/** Rooms are ClassSchedule.ScheduleID; an ad-hoc test room has no class to file under. */
function scheduleIdOf(meetingId) {
  const id = String(meetingId || "").trim();
  return /^[0-9]{1,10}$/.test(id) ? Number(id) : null;
}

function urlFor(file) {
  return `${config.baseUrl}/recordings/${encodeURIComponent(file)}`;
}

/**
 * The columns `YouTubeRecords` actually has, read once from the database.
 *
 * The site owns this table, and it has more columns than the two this app
 * cares about. Any of them that is NOT NULL with no default has to be given a
 * value or MySQL rejects the whole INSERT -- which is exactly how a recording
 * ends up rendered, on disk, and invisible to the platform, with one error
 * line in a log nobody is reading. So the statement is built from the schema
 * rather than from an assumption about it.
 */
let columns = null;

async function describeTable() {
  if (columns) return columns;
  const rows = await query("SHOW COLUMNS FROM YouTubeRecords");
  columns = rows.map((r) => ({
    name: r.Field,
    type: String(r.Type || "").toLowerCase(),
    nullable: r.Null === "YES",
    hasDefault: r.Default !== null,
    generated: /auto_increment|GENERATED/i.test(String(r.Extra || "")),
  }));
  log.info("YouTubeRecords columns", { columns: columns.map((c) => c.name).join(", ") });
  return columns;
}

/** Something a NOT NULL column of this type will accept. */
function filler(column, now) {
  if (/^(datetime|timestamp)/.test(column.type)) return stamp(now);
  if (/^date/.test(column.type)) return stamp(now).slice(0, 10);
  if (/^time/.test(column.type)) return stamp(now).slice(11);
  if (/int|decimal|float|double|bit/.test(column.type)) return 0;
  return "";
}

/**
 * The INSERT, fitted to the table in front of it.
 *
 * ScheduleID and VideoURL are what this app knows. A column named for who
 * uploaded gets the same marker the attendance rows carry, so a row written
 * here is distinguishable from one the site wrote. Everything else that MySQL
 * would refuse to leave empty gets the emptiest value of its type -- present,
 * so the row lands, and obviously unset, so nobody mistakes it for data.
 */
function insertFor(schema, scheduleId, url, now = Date.now()) {
  const values = new Map([
    ["ScheduleID", scheduleId],
    ["VideoURL", url],
  ]);

  for (const column of schema) {
    if (values.has(column.name)) continue;
    if (column.generated) continue;
    if (/^uploaded_?by$/i.test(column.name)) {
      values.set(column.name, UPLOADED_BY);
      continue;
    }
    if (column.nullable || column.hasDefault) continue;
    values.set(column.name, filler(column, now));
  }

  const names = [...values.keys()];
  return {
    sql: `INSERT INTO YouTubeRecords (${names.map((n) => `\`${n}\``).join(", ")}) VALUES (${names
      .map(() => "?")
      .join(", ")})`,
    params: [...values.values()],
  };
}

/**
 * Writes the row, unless this exact video is already recorded against the
 * class.
 *
 * A restart mid-render re-queues the job, and re-rendering is deliberately
 * safe to repeat -- so publishing has to be too, or a class would collect a
 * second link to the same file every time the server was restarted at the
 * wrong moment. Two genuinely different recordings of one class still get two
 * rows, which is what the multiple rows per schedule in the table already are.
 */
async function publish({ meetingId, file }) {
  const scheduleId = scheduleIdOf(meetingId);
  if (scheduleId == null) {
    // Warn, not info. A whole class being unpublishable because its room is
    // not a ScheduleID is the sort of thing that should be visible in a log
    // somebody is scanning for why the platform has no video.
    log.warn("room id is not a ScheduleID — this recording cannot be filed against a class", {
      meetingId,
      file,
    });
    return null;
  }
  if (!config.baseUrl) {
    log.error("RECORDING_PUBLIC_BASE_URL is not set — cannot publish a usable link", {
      meetingId,
      file,
    });
    return null;
  }

  const url = urlFor(file);
  const existing = await query(
    "SELECT VideoID FROM YouTubeRecords WHERE ScheduleID = ? AND VideoURL = ? LIMIT 1",
    [scheduleId, url],
  );
  if (existing.length) {
    log.info("recording already published", { scheduleId, videoId: existing[0].VideoID });
    return existing[0].VideoID;
  }

  const { sql, params } = insertFor(await describeTable(), scheduleId, url);
  const result = await query(sql, params);
  log.action("recording published to the platform", {
    scheduleId,
    videoId: result.insertId,
    url,
  });
  return result.insertId;
}

/**
 * Publishes every finished recording that has no row yet.
 *
 * The live listener only hears renders that complete while this process is
 * running and subscribed. Anything that finished before the feature existed,
 * while the database was unreachable, or while the process was down, would
 * otherwise sit on disk as a file nobody on the platform knows about -- which
 * is exactly the state the recordings were found in.
 *
 * The job files are the record of what was rendered, so they are what this
 * reconciles against. Publishing is idempotent, so a sweep that runs on every
 * boot costs one query per finished recording and changes nothing it has
 * already done.
 */
async function sweep() {
  if (!config.enabled || !process.env.DB_HOST) return 0;
  const jobs = renderQueue
    .listJobs()
    .filter((job) => job.status === renderQueue.STATUS.COMPLETED && job.file);
  let published = 0;
  for (const job of jobs) {
    if (scheduleIdOf(job.meetingId) == null) continue;
    try {
      const before = await query(
        "SELECT VideoID FROM YouTubeRecords WHERE ScheduleID = ? AND VideoURL = ? LIMIT 1",
        [scheduleIdOf(job.meetingId), urlFor(job.file)],
      );
      if (before.length) continue;
      const videoId = await publish({ meetingId: job.meetingId, file: job.file });
      if (videoId) published += 1;
    } catch (err) {
      log.error("could not publish a finished recording", {
        meetingId: job.meetingId,
        file: job.file,
        error: err.message,
      });
    }
  }
  return published;
}

/**
 * Why the platform has, or has not, got a link for each recording.
 *
 * "The database is not updating" has half a dozen causes that all look
 * identical from outside -- writes switched off, no public URL configured, a
 * room that was never a scheduled class, a render that failed, a column the
 * INSERT does not satisfy -- and each one is a different fix. This answers the
 * question directly instead of leaving it to be inferred from a log.
 */
async function report() {
  const jobs = renderQueue.listJobs();
  const out = {
    enabled: config.enabled,
    baseUrl: config.baseUrl || null,
    database: process.env.DB_NAME || null,
    subscribed: started,
    reachable: null,
    columns: null,
    jobs: [],
  };

  if (!process.env.DB_HOST) {
    out.reason = "DB_HOST is not set — nothing is ever written";
    return out;
  }
  try {
    out.columns = (await describeTable()).map((c) => c.name);
    out.reachable = true;
  } catch (err) {
    out.reachable = false;
    out.reason = `the database rejected SHOW COLUMNS FROM YouTubeRecords: ${err.message}`;
    return out;
  }
  if (!config.enabled) out.reason = "RECORDING_DB_WRITES is off";
  else if (!config.baseUrl) out.reason = "neither RECORDING_PUBLIC_BASE_URL nor SSO_AUDIENCE is set";

  for (const job of jobs.slice(0, 50)) {
    const scheduleId = scheduleIdOf(job.meetingId);
    const row = { id: job.id, meetingId: job.meetingId, status: job.status, file: job.file };
    if (job.status !== renderQueue.STATUS.COMPLETED) {
      row.published = false;
      row.why = job.status === renderQueue.STATUS.FAILED ? `render failed: ${job.error}` : `render is ${job.status}`;
    } else if (scheduleId == null) {
      row.published = false;
      row.why = "the room id is not a ScheduleID, so there is no class to file it against";
    } else if (!config.baseUrl) {
      row.published = false;
      row.why = "no public base URL is configured";
    } else {
      try {
        const found = await query(
          "SELECT VideoID FROM YouTubeRecords WHERE ScheduleID = ? AND VideoURL = ? LIMIT 1",
          [scheduleId, urlFor(job.file)],
        );
        row.published = Boolean(found.length);
        row.videoId = found[0]?.VideoID || null;
        if (!row.published) row.why = "rendered, but no row — run the sweep or read the error below";
      } catch (err) {
        row.published = false;
        row.why = `lookup failed: ${err.message}`;
      }
    }
    out.jobs.push(row);
  }
  return out;
}

let started = false;

/** Subscribes to the render queue. Called once, at boot. */
function start() {
  if (started) return false;
  if (!config.enabled) {
    log.warn("recording database writes are OFF (RECORDING_DB_WRITES=0)");
    return false;
  }
  if (!process.env.DB_HOST) {
    log.warn("no DB_HOST — finished recordings stay on disk only");
    return false;
  }
  renderQueue.onStatus((job) => {
    if (job.status !== renderQueue.STATUS.COMPLETED || !job.file) return;
    // Not awaited: the queue is draining the next class and must not wait on
    // MySQL. A failure here loses the link, not the recording, and the file is
    // still listed by /api/recordings.
    publish({ meetingId: job.meetingId, file: job.file }).catch((err) => {
      log.error("could not publish the recording", {
        meetingId: job.meetingId,
        file: job.file,
        error: err.message,
      });
    });
  });
  started = true;
  if (!config.baseUrl) {
    log.error(
      "no RECORDING_PUBLIC_BASE_URL and no SSO_AUDIENCE — recordings will render but never reach YouTubeRecords",
    );
  }
  /**
   * A retry, on a timer.
   *
   * The listener above fires exactly once per recording. A database that was
   * unreachable at that moment used to lose the link permanently: the file
   * stayed on disk, rendered and fine, and the platform never learnt it
   * existed. Publishing is idempotent, so this simply re-asks.
   */
  if (SWEEP_MINUTES > 0) {
    setInterval(() => {
      sweep()
        .then((n) => {
          if (n) log.warn("published recordings that had no row", { published: n });
        })
        .catch((err) => log.error("recording sweep failed", err.message));
    }, SWEEP_MINUTES * 60 * 1000).unref();
  }
  log.info("publishing finished recordings to YouTubeRecords", {
    baseUrl: config.baseUrl,
    retryEveryMinutes: SWEEP_MINUTES,
  });
  return true;
}

module.exports = { start, sweep, report, publish, insertFor, urlFor, scheduleIdOf, config };
