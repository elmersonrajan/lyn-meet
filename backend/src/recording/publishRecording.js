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
const { createLogger } = require("../utils/logger");

const log = createLogger("Recordings");

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
    log.info("not a scheduled class — recording stays on disk only", { meetingId, file });
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

  const result = await query("INSERT INTO YouTubeRecords (ScheduleID, VideoURL) VALUES (?, ?)", [
    scheduleId,
    url,
  ]);
  log.action("recording published to the platform", {
    scheduleId,
    videoId: result.insertId,
    url,
  });
  return result.insertId;
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
  log.info("publishing finished recordings to YouTubeRecords", { baseUrl: config.baseUrl });
  return true;
}

module.exports = { start, publish, urlFor, scheduleIdOf, config };
