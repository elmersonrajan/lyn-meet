/**
 * Keeps the recordings directory to the recordings.
 *
 * Every capture leaves three diagnostic files behind -- an ffmpeg log, a job
 * file and an account of what happened -- and they are all worth having for
 * the class that just finished. They are worth nothing at all for the class
 * before that, and a term of them buries the .mp4 files somebody is actually
 * looking for, four diagnostics deep.
 *
 * So they are treated as what they are: the notes for the LAST recording, kept
 * until the next one replaces them.
 *
 * Two things are never swept, and the distinction is the whole point:
 *
 *   - **the .mp4 files**, obviously, and the sidecar .json beside each one --
 *     that pairs with its recording and says who could be heard in it, which
 *     is a property of the recording rather than a note about producing it.
 *   - **a job file whose render has not finished.** `resumePending()` reads
 *     those at boot to pick up a class the server died in the middle of. Sweep
 *     one of those and the recording is lost for good, which is precisely the
 *     disaster the job file exists to prevent.
 *
 * The decision is pure and tested; the deleting is done by the caller.
 */

const fs = require("fs");
const path = require("path");

const { createLogger } = require("../utils/logger");

const log = createLogger("LogSweep");

/** How many recordings keep their notes. One means "the last class". */
function keepCount() {
  const raw = Number(process.env.RECORDING_KEEP_LOGS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

/** The three kinds of note a recording leaves, keyed by its id. */
const SUFFIXES = ["_ffmpeg.log", "_events.jsonl", ".job.json"];

function idOf(name) {
  for (const suffix of SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return null;
}

/**
 * Which files should go.
 *
 * @param {string[]} names        everything in the directory
 * @param {(id:string)=>number} rankOf      newer recordings rank higher
 * @param {(id:string)=>boolean} isFinished whether the render is done with it
 * @param {number} keep
 * @returns {string[]} file names to delete
 */
function sweepable(names, rankOf, isFinished, keep = keepCount()) {
  const ids = new Set();
  for (const name of names) {
    const id = idOf(name);
    if (id) ids.add(id);
  }

  const ordered = [...ids].sort((a, b) => rankOf(b) - rankOf(a));
  const doomed = new Set(ordered.slice(keep));

  return names.filter((name) => {
    const id = idOf(name);
    if (!id || !doomed.has(id)) return false;
    // Never a job still waiting to be rendered: that file is the only thing
    // that would bring the class back after a restart.
    if (name.endsWith(".job.json") && !isFinished(id)) return false;
    return true;
  });
}

/**
 * Does it, against a real directory.
 *
 * @param {string} dir
 * @param {(id:string)=>boolean} isFinished
 */
function run(dir, isFinished = () => true) {
  try {
    if (!fs.existsSync(dir)) return [];
    const names = fs.readdirSync(dir);
    // Modification time, because a recording's id carries no order anyone can
    // read and the job file is rewritten as the render progresses.
    const rankOf = (id) => {
      let newest = 0;
      for (const suffix of SUFFIXES) {
        try {
          newest = Math.max(newest, fs.statSync(path.join(dir, id + suffix)).mtimeMs);
        } catch {
          /* that kind of note was never written */
        }
      }
      return newest;
    };

    const doomed = sweepable(names, rankOf, isFinished);
    for (const name of doomed) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (err) {
        log.error("could not remove an old recording note", err.message);
      }
    }
    if (doomed.length) log.info("swept old recording notes", { removed: doomed.length });
    return doomed;
  } catch (err) {
    log.error("sweep failed (harmless)", err);
    return [];
  }
}

module.exports = { run, sweepable, keepCount, SUFFIXES };
