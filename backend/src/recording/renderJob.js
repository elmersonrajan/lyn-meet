const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");
const { RECORDINGS_DIR, fileSize } = require("./paths");
const { resolveOutputPath } = require("./recordingName");
const { buildBoardVideoArgs, buildAudioMixArgs, buildComposeArgs } = require("./ffmpegArgs");
const { probeMedia } = require("./probeMedia");

const log = createLogger("RenderJob");

/**
 * Turns a finished capture into the final MP4.
 *
 * Deliberately knows nothing about rooms, peers, sockets or mediasoup: it is
 * handed a plain description of files on disk and works from that alone. That
 * is what lets it keep going after the teacher has closed the tab, after the
 * room has been torn down, and -- because the description is a file -- across a
 * restart of the server.
 *
 * Built in three separate passes rather than one command:
 *
 *   1. the whiteboard flipbook becomes a video
 *   2. every microphone becomes one mixed audio track
 *   3. the layout is assembled from those two plus the capture
 *
 * Each can fail without taking the others with it. When audio and layout were
 * one command, a single awkward voice file failed the whole thing and the class
 * quietly saved with no student audio at all.
 */

const MIN_USEFUL_BYTES = 2000;

function runFfmpeg(args, label, logPath) {
  return new Promise((resolve) => {
    const command = `ffmpeg ${args.join(" ")}`;
    log.info(`ffmpeg ${label}`, command);
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let errText = "";
    proc.stderr.on("data", (chunk) => {
      errText += String(chunk);
    });

    const finish = (ok, code, signal, spawnError) => {
      const tail = errText.trim().split(/\r?\n/).slice(-6).join(" | ");
      if (tail) log.info(`ffmpeg ${label}`, tail);
      if (logPath) {
        try {
          fs.appendFileSync(
            logPath,
            `\n=== ${label} @ ${new Date().toISOString()} ===\n${command}\n` +
              `exit: code=${code} signal=${signal}` +
              `${spawnError ? ` spawnError=${spawnError}` : ""}\n${errText}\n`,
            "utf8",
          );
        } catch (err) {
          log.error("could not write the ffmpeg log", err);
        }
      }
      resolve({ ok, code, signal, stderr: errText });
    };

    proc.on("error", (err) => finish(false, null, null, err.message));
    proc.on("exit", (code, signal) => finish(code === 0, code, signal, null));
  });
}

/** @returns {Promise<string|null>} the board video, or null if it could not be built */
async function makeBoardVideo(job) {
  if (!job.boardManifest || !fs.existsSync(job.boardManifest)) {
    log.info("no whiteboard frames to build", { id: job.id });
    return null;
  }
  const out = path.join(RECORDINGS_DIR, `${job.id}_board.mp4`);
  const res = await runFfmpeg(
    buildBoardVideoArgs({ manifest: job.boardManifest, outputPath: out }),
    "board-video",
    job.logPath,
  );
  if (!res.ok || fileSize(out) < MIN_USEFUL_BYTES) {
    log.warn("whiteboard video failed — continuing without the board", {
      id: job.id,
      code: res.code,
      bytes: fileSize(out),
    });
    return null;
  }
  log.info("whiteboard video built", { id: job.id, bytes: fileSize(out) });
  return out;
}

/**
 * Mixes the teacher with every other microphone that was recorded.
 *
 * If the mix fails, the class still gets the teacher's audio straight from the
 * capture -- but the caller is told, so a lost voice is reported rather than
 * looking like it was never recorded.
 *
 * @returns {Promise<{path:string|null, voices:Array, degraded:boolean}>}
 */
async function makeMixedAudio(job, hasAudio) {
  const voices = (job.sides || [])
    .filter((s) => s.kind === "audio" && fileSize(s.path) >= MIN_USEFUL_BYTES)
    .map((s) => ({ path: s.path, offsetMs: s.offsetMs, name: s.name, role: s.role }));

  const dropped = (job.sides || []).filter(
    (s) => s.kind === "audio" && fileSize(s.path) < MIN_USEFUL_BYTES,
  );
  if (dropped.length) {
    log.warn("some voices captured nothing and are being skipped", {
      id: job.id,
      names: dropped.map((s) => s.name),
    });
  }

  // Nothing to combine: the layout can take the teacher's audio directly.
  if (!voices.length) return { path: null, voices: [], degraded: false };

  const out = path.join(RECORDINGS_DIR, `${job.id}_audio.m4a`);
  const args = buildAudioMixArgs({
    livePath: job.livePath,
    hasAudio,
    voices,
    outputPath: out,
  });
  if (!args) return { path: null, voices: [], degraded: false };

  const res = await runFfmpeg(args, "audio-mix", job.logPath);
  if (!res.ok || fileSize(out) < MIN_USEFUL_BYTES) {
    log.error("audio mix failed — the class will have the teacher only", {
      id: job.id,
      code: res.code,
      voices: voices.map((v) => v.name),
    });
    return { path: null, voices: [], degraded: true };
  }
  log.info("audio mixed", {
    id: job.id,
    voices: voices.map((v) => `${v.name} (${v.role})`),
    bytes: fileSize(out),
  });
  return { path: out, voices, degraded: false };
}

function writeSidecar(job, result) {
  try {
    fs.writeFileSync(
      path.join(RECORDINGS_DIR, `${result.file.replace(/\.mp4$/, "")}.json`),
      JSON.stringify(
        {
          id: job.id,
          meetingId: job.meetingId,
          file: result.file,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          layout: result.layout,
          attempt: result.attempt,
          hasAudio: result.hasAudio,
          hasCamera: result.hasCamera,
          hasScreen: result.hasScreen,
          hasWhiteboard: result.hasWhiteboard,
          // Who can be heard besides the teacher, so a recording can be checked
          // without watching it.
          voices: result.voices.map((v) => ({ name: v.name, role: v.role })),
          dropped: result.dropped,
          whiteboard: job.whiteboard || [],
        },
        null,
        2,
      ),
    );
  } catch (err) {
    log.error("could not write the sidecar", err);
  }
}

/** Keeps the unlaid-out capture under a findable name when every layout failed. */
function preserveRawCapture(job) {
  try {
    if (fileSize(job.livePath) < MIN_USEFUL_BYTES) {
      log.warn("no capture to preserve", { id: job.id });
      return null;
    }
    const { name } = resolveOutputPath(
      RECORDINGS_DIR,
      `${job.meetingId}_raw`,
      job.startedAt || Date.now(),
    );
    const rawName = name.replace(/\.mp4$/, ".mkv");
    const rawPath = path.join(RECORDINGS_DIR, rawName);
    fs.renameSync(job.livePath, rawPath);
    log.warn("kept the raw capture instead", { file: rawName, bytes: fileSize(rawPath) });
    return rawName;
  } catch (err) {
    log.error("could not preserve the raw capture", err);
    return null;
  }
}

/** Intermediates are only removed once the final file exists. */
function cleanupIntermediates(job, extras) {
  try {
    if (job.frameDir && fs.existsSync(job.frameDir)) {
      fs.rmSync(job.frameDir, { recursive: true, force: true });
    }
    const sideFiles = (job.sides || []).flatMap((s) => [s.path, s.sdpPath]);
    // The ffmpeg log is deliberately kept: it is small, and it is the record of
    // how this recording was produced.
    for (const p of [job.livePath, ...(job.sdpPaths || []), ...sideFiles, ...extras]) {
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  } catch (err) {
    log.error("cleanup failed (harmless)", err);
  }
}

/**
 * Renders one capture. Never throws: a failure is a result, because the caller
 * is a background worker that has to carry on to the next job either way.
 *
 * @returns {Promise<{ok:boolean, file:string|null, layout:string|null,
 *   voices:Array, dropped:string[], error:string|null}>}
 */
async function renderJob(job) {
  const dropped = [];
  try {
    if (fileSize(job.livePath) < MIN_USEFUL_BYTES) {
      return {
        ok: false,
        file: null,
        layout: null,
        voices: [],
        dropped,
        error: "nothing was captured",
      };
    }

    // Trust the file over the recorder's bookkeeping: a producer that sent no
    // RTP leaves no stream, and a layout referencing a missing stream fails.
    let camIndex = job.camIndex;
    let screenIndex = job.screenIndex;
    let hasAudio = job.hasAudio;
    const probe = probeMedia(job.livePath);
    if (probe) {
      log.info("probed capture", { id: job.id, ...probe });
      if (camIndex != null && camIndex >= probe.videoCount) camIndex = null;
      if (screenIndex != null && screenIndex >= probe.videoCount) screenIndex = null;
      hasAudio = probe.hasAudio;
    }

    const boardVideo = await makeBoardVideo(job);
    if (!boardVideo && job.boardManifest) dropped.push("whiteboard");

    const audio = await makeMixedAudio(job, hasAudio);
    if (audio.degraded) dropped.push("student and coordinator audio");

    const screenSides = (job.sides || []).filter((s) => s.kind === "video");
    const sideScreenRaw = screenSides.find((s) => fileSize(s.path) >= MIN_USEFUL_BYTES);
    // An empty screen capture used to be dropped without a word, so a class
    // with a share in it produced a file with no share and no explanation.
    for (const s of screenSides) {
      if (s === sideScreenRaw) continue;
      log.error("a screen share was captured but holds nothing — leaving it out", {
        id: job.id,
        who: s.name,
        path: s.path,
        bytes: fileSize(s.path),
      });
      dropped.push(`screen share from ${s.name}`);
    }
    if (!screenSides.length && job.screenIndex == null) {
      log.info("no screen share was captured for this class", { id: job.id });
    }
    const sideScreen = sideScreenRaw
      ? { path: sideScreenRaw.path, offsetMs: sideScreenRaw.offsetMs }
      : null;

    const resolved = resolveOutputPath(RECORDINGS_DIR, job.meetingId, job.startedAt || Date.now());
    const outputPath = resolved.fullPath;

    // Richest first; each step drops whatever is most likely to be at fault.
    // Audio is never dropped here -- it is a finished file by this point, and
    // losing the voices is exactly the failure this ordering exists to avoid.
    const base = { boardVideo, camIndex, screenIndex, sideScreen };
    const attempts = [
      { label: "full", ...base },
      { label: "no-side-screen", ...base, sideScreen: null },
      { label: "no-screen", ...base, sideScreen: null, screenIndex: null },
      { label: "no-board", ...base, sideScreen: null, boardVideo: null },
      { label: "no-camera", ...base, sideScreen: null, camIndex: null },
      { label: "camera-only", ...base, sideScreen: null, boardVideo: null, screenIndex: null },
      {
        label: "audio-only",
        ...base,
        sideScreen: null,
        boardVideo: null,
        camIndex: null,
        screenIndex: null,
      },
    ];

    const tried = new Set();
    for (const attempt of attempts) {
      const nothingToShow =
        attempt.boardVideo == null &&
        attempt.camIndex == null &&
        attempt.screenIndex == null &&
        attempt.sideScreen == null;
      if (nothingToShow && !hasAudio && !audio.path) continue;

      // Dropping an element that was never captured produces the same command
      // twice; running it again would only fail again.
      const key = [
        Boolean(attempt.boardVideo),
        attempt.camIndex,
        attempt.screenIndex,
        Boolean(attempt.sideScreen),
      ].join("|");
      if (tried.has(key)) continue;
      tried.add(key);

      const res = await runFfmpeg(
        buildComposeArgs({
          livePath: job.livePath,
          boardVideo: attempt.boardVideo,
          outputPath,
          camIndex: attempt.camIndex,
          screenIndex: attempt.screenIndex,
          sideScreen: attempt.sideScreen,
          audioPath: audio.path,
          hasAudio,
        }),
        `compose:${attempt.label}`,
        job.logPath,
      );

      const produced = fileSize(outputPath);
      if (res.ok && produced >= MIN_USEFUL_BYTES) {
        if (attempt.label !== "full") dropped.push(`layout reduced to ${attempt.label}`);
        const shared = attempt.screenIndex != null || Boolean(attempt.sideScreen);
        const result = {
          ok: true,
          file: resolved.name,
          layout: attempt.boardVideo
            ? shared
              ? "whiteboard + screen overlay"
              : "whiteboard"
            : shared
              ? "screen"
              : "camera",
          attempt: attempt.label,
          hasAudio: hasAudio || Boolean(audio.path),
          hasCamera: attempt.camIndex != null,
          hasScreen: shared,
          hasWhiteboard: Boolean(attempt.boardVideo),
          voices: audio.voices,
          dropped,
          error: null,
        };
        writeSidecar(job, result);
        cleanupIntermediates(job, [boardVideo, audio.path]);
        log.info("render done", {
          id: job.id,
          output: result.file,
          layout: attempt.label,
          bytes: produced,
          voices: audio.voices.length,
        });
        return result;
      }

      log.warn(`compose ${attempt.label} failed — trying a simpler layout`, {
        id: job.id,
        code: res.code,
        bytes: produced,
        error: res.stderr.trim().split(/\r?\n/).slice(-3).join(" | "),
      });
      try {
        fs.rmSync(outputPath, { force: true });
      } catch {
        /* nothing to remove */
      }
    }

    log.error("every layout failed — see the ffmpeg log", { id: job.id, logPath: job.logPath });
    const raw = preserveRawCapture(job);
    return {
      ok: false,
      file: raw,
      layout: raw ? "raw capture" : null,
      voices: [],
      dropped,
      error: "every layout failed — the raw capture was kept",
    };
  } catch (err) {
    log.error("render failed", err);
    return { ok: false, file: null, layout: null, voices: [], dropped, error: err.message };
  }
}

module.exports = { renderJob };
