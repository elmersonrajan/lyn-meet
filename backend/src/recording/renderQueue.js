const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");
const { RECORDINGS_DIR, ensureDir } = require("./paths");
const { renderJob } = require("./renderJob");

const log = createLogger("RenderQueue");

/**
 * The background half of recording.
 *
 * Pressing stop has to mean "the capture is safely on disk", not "wait while an
 * hour of class is re-encoded". So stopping writes a job file describing what
 * was captured and returns; everything after that happens here, with no teacher
 * waiting on it.
 *
 * The job file is the whole point. Because the queue's state lives on disk and
 * not in a socket, a room or a promise:
 *
 *   - the teacher can close the tab the moment they have stopped
 *   - the room can be torn down while the render is still running
 *   - a restart mid-render picks the job back up instead of losing the class
 *
 * One render at a time, deliberately. Each is several ffmpeg passes on a box
 * that is also running the SFU, and ten classes finishing together would
 * otherwise bury it -- which is exactly what happened when stop ran the layout
 * inline and got pressed repeatedly.
 */

const STATUS = {
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
};

const listeners = new Set();
const queue = [];
let running = false;

function jobPath(id) {
  return path.join(RECORDINGS_DIR, `${id}.job.json`);
}

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), "utf8"));
  } catch {
    return null;
  }
}

function writeJob(job) {
  try {
    ensureDir(RECORDINGS_DIR);
    fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
  } catch (err) {
    log.error("could not write the job file", err);
  }
}

/** What the frontend and the REST endpoint see. Never the intermediate paths. */
function publicStatus(job) {
  return {
    id: job.id,
    meetingId: job.meetingId,
    status: job.status,
    file: job.file || null,
    url: job.file ? `/recordings/${encodeURIComponent(job.file)}` : null,
    layout: job.layout || null,
    voices: job.voices || [],
    // Anything the render could not include, so a degraded recording says so
    // rather than looking complete.
    dropped: job.dropped || [],
    error: job.error || null,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    queuedAt: job.queuedAt,
    completedAt: job.completedAt || null,
  };
}

function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(job) {
  const payload = publicStatus(job);
  for (const fn of listeners) {
    try {
      fn(payload);
    } catch (err) {
      log.error("status listener failed", err);
    }
  }
}

function setStatus(job, status, extra = {}) {
  Object.assign(job, extra, { status });
  writeJob(job);
  log.info("recording status", { id: job.id, meetingId: job.meetingId, status });
  emit(job);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const job = readJob(id);
      if (!job) {
        log.warn("job file vanished — skipping", { id });
        continue;
      }
      setStatus(job, STATUS.PROCESSING, { processingStartedAt: Date.now() });
      const result = await renderJob(job);
      setStatus(job, result.ok ? STATUS.COMPLETED : STATUS.FAILED, {
        file: result.file,
        layout: result.layout,
        voices: result.voices.map((v) => ({ name: v.name, role: v.role })),
        dropped: result.dropped,
        error: result.error,
        completedAt: Date.now(),
      });
    }
  } catch (err) {
    log.error("queue drain failed", err);
  } finally {
    running = false;
    // A job enqueued while the last one was finishing would otherwise sit here
    // until the next stop.
    if (queue.length) drain();
  }
}

/**
 * Hands a finished capture over for rendering and returns immediately.
 * @returns {object} the job's public status, already `queued`
 */
function enqueue(job) {
  const queued = { ...job, status: STATUS.QUEUED, queuedAt: Date.now() };
  writeJob(queued);
  queue.push(queued.id);
  log.action("queued for rendering", {
    id: queued.id,
    meetingId: queued.meetingId,
    ahead: queue.length - 1,
  });
  emit(queued);
  // Not awaited: the caller is a teacher waiting for a button to respond.
  drain();
  return publicStatus(queued);
}

/**
 * Picks up anything that was mid-render when the process last stopped.
 *
 * A restart used to lose the class outright: the capture was on disk with
 * nobody left who knew it needed rendering. Anything not completed is simply
 * queued again -- rendering reads the capture and writes a new output, so
 * running it twice is safe.
 */
function resumePending() {
  try {
    ensureDir(RECORDINGS_DIR);
    const pending = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith(".job.json"))
      .map((f) => readJob(f.replace(/\.job\.json$/, "")))
      .filter((j) => j && j.status !== STATUS.COMPLETED && j.status !== STATUS.FAILED);

    if (!pending.length) return 0;
    log.warn("resuming recordings left unrendered by a restart", {
      count: pending.length,
      ids: pending.map((j) => j.id),
    });
    for (const job of pending) {
      queue.push(job.id);
    }
    drain();
    return pending.length;
  } catch (err) {
    log.error("resumePending failed", err);
    return 0;
  }
}

/** Every known recording job, newest first. Backs the REST status endpoint. */
function listJobs() {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return [];
    return fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith(".job.json"))
      .map((f) => readJob(f.replace(/\.job\.json$/, "")))
      .filter(Boolean)
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
      .map(publicStatus);
  } catch (err) {
    log.error("listJobs failed", err);
    return [];
  }
}

function getJob(id) {
  const job = readJob(id);
  return job ? publicStatus(job) : null;
}

module.exports = { STATUS, enqueue, resumePending, listJobs, getJob, onStatus, publicStatus };
