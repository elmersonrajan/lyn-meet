const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");
const { writeBoardFrame } = require("./whiteboardFrame");
const { resolveOutputPath } = require("./recordingName");
const { buildSdp, buildIngestArgs, buildBoardVideoArgs, buildComposeArgs } = require("./ffmpegArgs");
const { probeMedia } = require("./probeMedia");

const log = createLogger("CloudRecorder");

const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || path.join(__dirname, "../../recordings"),
);

const BOARD_FPS = Number(process.env.RECORDING_BOARD_FPS || 1);
// Long enough for ffmpeg to bind its UDP sockets before any RTP is sent.
const INGEST_WARMUP_MS = Number(process.env.RECORDING_WARMUP_MS || 700);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Handed out in sequence rather than at random so two sources, or two rooms
// recording at once, can never land on the same port.
let nextPort = 20000;
function pickPort() {
  nextPort = nextPort >= 39998 ? 20000 : nextPort + 2;
  return nextPort;
}

function fileSize(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function codecInfo(consumer) {
  const codec = consumer.rtpParameters.codecs[0];
  const [, name] = codec.mimeType.split("/");
  return {
    codecName: name,
    payloadType: codec.payloadType,
    clockRate: codec.clockRate,
    channels: codec.channels || 2,
  };
}

/**
 * Runs ffmpeg and reports the outcome rather than throwing, so the caller can
 * try a simpler layout instead of losing the recording.
 *
 * The command and its complete output are appended to a log beside the
 * recording. Previously failures went only to the server log, interleaved with
 * everything else, which is why a broken layout was so hard to pin down.
 */
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Compose runs one at a time across the whole server.
 *
 * Each compose is several ffmpeg passes at once; a box that is also running the
 * SFU cannot absorb one per room. When a teacher clicked stop repeatedly the
 * duplicate composes buried the machine and it had to be restarted, so laying
 * out a finished class now waits its turn instead of competing for the CPU.
 */
let composeChain = Promise.resolve();
function queueCompose(task) {
  const run = composeChain.then(task, task);
  composeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Server-side recording: one composed MP4 per session containing the whiteboard
 * (or a shared screen), the teacher camera as an inset, and the teacher audio.
 *
 * Capture and layout are separate stages on purpose:
 *
 *   1. Ingest — ONE ffmpeg process reads every RTP stream through a single SDP
 *      and writes them, unmodified, into one Matroska file. One process means
 *      one clock, so audio, camera and screen stay in step with each other.
 *   2. Compose — at stop, that file plus the whiteboard frames are laid out into
 *      the final MP4. Only the video track is rebuilt, so nothing here can
 *      disturb the audio timing captured in stage 1.
 *
 * Doing the layout live would mean re-encoding under real-time pressure on a
 * box that is also running the SFU; if it fell behind, frames would be dropped
 * and the result would drift. Composing afterwards can take the time it needs.
 */
class CloudRecorder {
  constructor(room) {
    this.room = room;
    this.id = `rec_${Date.now()}`;
    this.room_id = room.id;
    this.active = false;
    this.startedAt = null;
    this.endedAt = null;
    // Capture teardown and layout are separate phases with separate promises, so
    // repeat calls to either join the one already running instead of starting a
    // second copy over the same files.
    this._captureStopPromise = null;
    this._finalizePromise = null;
    this.finalizing = false;
    this.composed = false;

    this.ingestProc = null;
    this.transports = [];
    this.consumers = [];
    // source -> { remoteRtpPort, payloadType, consumer, producerId }, so a
    // producer replaced mid-class can be reconnected to the port ffmpeg is
    // already reading.
    this.tracks = new Map();

    this.sdpPath = null;
    this.livePath = null;
    this.outputPath = null;
    this.outputName = null;
    // Every ffmpeg command and its full output, kept beside the recording so a
    // failure can be diagnosed without digging through the server log.
    this.logPath = null;
    this.boardVideoPath = null;
    this.layoutUsed = null;

    this.frameDir = null;
    this.frameTimer = null;
    this.frameIndex = 0;
    // { name, at } per board frame, in order. The gaps between them are the
    // frame durations written into the concat manifest.
    this.frames = [];
    this.lastBoardSignature = null;
    // When ffmpeg started reading RTP. Board time zero is measured from here,
    // not from the first snapshot, or the board would lag the audio by the
    // ingest warm-up.
    this.captureStartedAt = null;

    // Stream order inside the ingest file, needed by the compose filter graph.
    this.camIndex = null;
    this.screenIndex = null;
    this.hasAudio = false;
  }

  async start() {
    try {
      log.action("start", { roomId: this.room.id, recorderId: this.id });
      ensureDir(RECORDINGS_DIR);

      const teacher = this.room.getTeacher();
      if (!teacher) throw new Error("Cannot start cloud recording without a teacher in the room");

      const audioProducer = this.room.findProducer(teacher.id, "audio");
      const camProducer = this.room.findProducer(teacher.id, "video");
      const screenProducer = this.room.findProducer(teacher.id, "screen");

      if (!audioProducer && !camProducer && !screenProducer) {
        throw new Error("Nothing to record — the teacher has no camera, mic or screen running");
      }

      const audio = audioProducer ? await this._attach(audioProducer, "audio") : null;
      const cam = camProducer ? await this._attach(camProducer, "video") : null;
      const screen = screenProducer ? await this._attach(screenProducer, "screen") : null;

      this.hasAudio = Boolean(audio);
      // Video stream indexes within the output, in SDP order.
      let v = 0;
      this.camIndex = cam ? v++ : null;
      this.screenIndex = screen ? v++ : null;

      this.frameDir = path.join(RECORDINGS_DIR, `${this.id}_frames`);
      ensureDir(this.frameDir);
      this.sdpPath = path.join(RECORDINGS_DIR, `${this.id}.sdp`);
      this.livePath = path.join(RECORDINGS_DIR, `${this.id}_live.mkv`);
      this.logPath = path.join(RECORDINGS_DIR, `${this.id}_ffmpeg.log`);

      fs.writeFileSync(this.sdpPath, buildSdp({ audio, cam, screen }), "utf8");

      const args = buildIngestArgs({
        sdpPath: this.sdpPath,
        outputPath: this.livePath,
        hasAudio: this.hasAudio,
      });
      log.info("ffmpeg ingest", args.join(" "));
      this.captureStartedAt = Date.now();
      this.ingestProc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.ingestProc.stderr.on("data", (c) => {
        const line = String(c).trim();
        if (line) log.info("ffmpeg ingest", line);
      });
      this.ingestProc.on("error", (err) =>
        log.error("ffmpeg ingest error — is ffmpeg installed?", err),
      );
      this.ingestProc.on("exit", (code, signal) =>
        log.info("ffmpeg ingest exited", { code, signal, bytes: fileSize(this.livePath) }),
      );

      // Let ffmpeg bind before any packet is sent. RTP delivered before it is
      // listening is simply lost, and losing the opening video keyframe is what
      // made audio start immediately while video appeared seconds later.
      await wait(INGEST_WARMUP_MS);

      for (const consumer of this.consumers) {
        await consumer.resume();
      }

      // Ask for a fresh keyframe now that the socket is up, so decoding can
      // begin at once instead of waiting for the encoder's next natural one.
      for (const consumer of this.consumers) {
        if (consumer.kind !== "video") continue;
        try {
          await consumer.requestKeyFrame();
        } catch (err) {
          log.warn("requestKeyFrame failed (continuing)", err.message);
        }
      }

      this.active = true;
      this.startedAt = Date.now();
      this._writeBoardSnapshot();
      this.frameTimer = setInterval(() => this._writeBoardSnapshot(), 1000 / BOARD_FPS);

      log.info("cloud recording started", {
        roomId: this.room.id,
        streams: { audio: this.hasAudio, cam: this.camIndex != null, screen: this.screenIndex != null },
      });
      return this.snapshot();
    } catch (err) {
      log.error("start failed", err);
      // Release the ports and transports, but do not queue a compose: there is
      // nothing captured to lay out.
      await this.stopCapture().catch(() => {});
      throw err;
    }
  }

  /**
   * Feeds one producer into the port ffmpeg reads for that source.
   *
   * The port is chosen once per source and reused for the rest of the class:
   * the SDP ffmpeg was started with is fixed, so a replacement producer has to
   * arrive on the same port to be picked up.
   */
  async _attach(producer, source, remoteRtpPort = pickPort()) {
    const transport = await this.room.router.createPlainTransport({
      listenInfo: { protocol: "udp", ip: "127.0.0.1" },
      rtcpMux: true,
      comedia: false,
    });
    this.transports.push(transport);
    await transport.connect({ ip: "127.0.0.1", port: remoteRtpPort });

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.room.router.rtpCapabilities,
      paused: true,
    });
    this.consumers.push(consumer);

    const info = codecInfo(consumer);
    this.tracks.set(source, {
      ...info,
      remoteRtpPort,
      consumer,
      producerId: producer.id,
    });

    // A producer that closes mid-class leaves this consumer dead and its stream
    // silently absent from the rest of the capture. Recorded so a replacement
    // can be spotted rather than the class simply losing the camera.
    consumer.on("producerclose", () => {
      const track = this.tracks.get(source);
      if (track && track.consumer === consumer) track.consumer = null;
      log.warn("recording source ended mid-class", { source, producerId: producer.id });
    });

    log.info("recording consumer attached", {
      kind: producer.kind,
      source,
      remoteRtpPort,
      codec: info.codecName,
    });
    return { ...info, remoteRtpPort };
  }

  /**
   * Reconnects a recorded source to a producer that replaced the original.
   *
   * A teacher who drops and rejoins publishes a brand new camera and mic; the
   * recorder was bound to the old ones and never looked again, so the teacher
   * reappeared in the meeting but vanished from the recording for the rest of
   * the class. Called by the room whenever a producer is created.
   */
  async onProducerAdded(peer, producer) {
    try {
      if (!this.active) return;
      const teacher = this.room.getTeacher();
      if (!teacher || peer.id !== teacher.id) return;

      const source = producer.appData?.source;
      const track = this.tracks.get(source);
      // Only sources that were part of this recording from the start have a
      // port in the SDP; a screen share begun later has nowhere to go.
      if (!track || track.consumer) return;

      const replacement = await this.room.router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: "127.0.0.1" },
        rtcpMux: true,
        comedia: false,
      });
      this.transports.push(replacement);
      await replacement.connect({ ip: "127.0.0.1", port: track.remoteRtpPort });

      const consumer = await replacement.consume({
        producerId: producer.id,
        rtpCapabilities: this.room.router.rtpCapabilities,
        paused: true,
      });
      const info = codecInfo(consumer);
      // ffmpeg maps the payload type to a decoder from the SDP written at
      // start. A different one would be undecodable noise on that port, so it
      // is better to leave the gap than to corrupt the stream.
      if (info.payloadType !== track.payloadType) {
        consumer.close();
        replacement.close();
        log.warn("cannot re-attach: payload type changed", {
          source,
          was: track.payloadType,
          now: info.payloadType,
        });
        return;
      }

      this.consumers.push(consumer);
      track.consumer = consumer;
      track.producerId = producer.id;
      consumer.on("producerclose", () => {
        if (track.consumer === consumer) track.consumer = null;
        log.warn("recording source ended mid-class", { source, producerId: producer.id });
      });

      await consumer.resume();
      if (consumer.kind === "video") {
        try {
          await consumer.requestKeyFrame();
        } catch (err) {
          log.warn("requestKeyFrame after re-attach failed (continuing)", err.message);
        }
      }
      log.info("recording source re-attached", { source, port: track.remoteRtpPort });
    } catch (err) {
      log.error("re-attach failed — recording continues without that source", err);
    }
  }

  /**
   * Strokes are appended whole and a clear empties the list, so the count plus
   * the last stroke's timestamp changes on every edit and on nothing else.
   */
  _boardSignature() {
    const strokes = this.room.whiteboard || [];
    return `${strokes.length}:${strokes[strokes.length - 1]?.at || 0}`;
  }

  /**
   * Records where the board stood at this instant.
   *
   * An unchanged board reuses the previous image instead of writing an
   * identical one: a teacher talking over a finished diagram for ten minutes
   * produced hundreds of byte-identical PNGs. The manifest holds the timeline,
   * so a reused frame simply stays on screen for longer.
   */
  _writeBoardSnapshot() {
    try {
      const at = Date.now();
      const signature = this._boardSignature();
      if (this.frames.length && signature === this.lastBoardSignature) {
        this.frames.push({ name: this.frames[this.frames.length - 1].name, at });
        return;
      }
      const name = `board_${String(this.frameIndex).padStart(6, "0")}.png`;
      writeBoardFrame(path.join(this.frameDir, name), this.room.whiteboard || []);
      this.frameIndex += 1;
      this.lastBoardSignature = signature;
      this.frames.push({ name, at });
    } catch (err) {
      log.error("board snapshot failed", err);
    }
  }

  /**
   * Writes the frame list as a concat manifest carrying each frame's real
   * duration, in seconds, measured from the capture clock.
   *
   * @returns {string|null} the manifest path, or null if there is nothing to build
   */
  _writeBoardManifest() {
    if (!this.frames.length) return null;
    const endedAt = this.endedAt || Date.now();
    // Board time zero is when ffmpeg began reading RTP, so the first frame
    // covers the ingest warm-up rather than the board starting late.
    const startAt = this.captureStartedAt || this.frames[0].at;
    const lines = ["ffconcat version 1.0"];

    for (let i = 0; i < this.frames.length; i += 1) {
      const from = i === 0 ? startAt : this.frames[i].at;
      const to = i + 1 < this.frames.length ? this.frames[i + 1].at : endedAt;
      const seconds = Math.max(0.04, (to - from) / 1000);
      lines.push(`file '${this.frames[i].name}'`, `duration ${seconds.toFixed(3)}`);
    }
    // The concat demuxer gives the final entry no duration of its own, so the
    // last image is repeated to hold the closing state on screen.
    lines.push(`file '${this.frames[this.frames.length - 1].name}'`);

    const manifestPath = path.join(this.frameDir, "board.ffconcat");
    fs.writeFileSync(manifestPath, `${lines.join("\n")}\n`, "utf8");
    return manifestPath;
  }

  /** SIGINT lets ffmpeg finalise the container; SIGKILL would truncate it. */
  async _stopIngest() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    this._writeBoardSnapshot();

    const proc = this.ingestProc;
    this.ingestProc = null;
    if (!proc || proc.killed) return;

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        log.warn("ingest did not exit in time — forcing");
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 8000);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        proc.kill("SIGINT");
      } catch (err) {
        clearTimeout(timeout);
        log.error("kill ingest failed", err);
        resolve();
      }
    });
  }

  /**
   * Builds the whiteboard video as its own step, so a problem with the frame
   * sequence cannot take the layout down with it.
   * @returns {Promise<string|null>} the video path, or null if it could not be made
   */
  async _makeBoardVideo() {
    if (this.frameIndex < 1) {
      log.info("no whiteboard frames to build");
      return null;
    }
    const manifest = this._writeBoardManifest();
    if (!manifest) return null;

    const out = path.join(RECORDINGS_DIR, `${this.id}_board.mp4`);
    const res = await runFfmpeg(
      buildBoardVideoArgs({ manifest, outputPath: out }),
      "board-video",
      this.logPath,
    );
    if (!res.ok || fileSize(out) < 2000) {
      log.warn("whiteboard video failed — continuing without the board", {
        code: res.code,
        bytes: fileSize(out),
      });
      return null;
    }
    this.boardVideoPath = out;
    log.info("whiteboard video built", { bytes: fileSize(out), frames: this.frameIndex });
    return out;
  }

  /**
   * Lays the capture out, falling back to progressively simpler arrangements.
   *
   * Every earlier failure produced either a 0-byte file or a bare capture with
   * no layout, because there was one attempt and no alternative. Now the richest
   * arrangement is tried first and each fallback drops one element, so the worst
   * outcome is a plain playable recording rather than nothing.
   */
  async _compose() {
    const live = fileSize(this.livePath);
    if (live < 2000) {
      log.warn("nothing captured — skipping compose", { livePath: this.livePath, bytes: live });
      return false;
    }

    // Trust the file over our own bookkeeping: a producer that sent no RTP
    // leaves no stream, and a layout referencing a missing stream fails.
    const probe = probeMedia(this.livePath);
    let camIndex = this.camIndex;
    let screenIndex = this.screenIndex;
    let hasAudio = this.hasAudio;
    if (probe) {
      log.info("probed capture", probe);
      if (camIndex != null && camIndex >= probe.videoCount) camIndex = null;
      if (screenIndex != null && screenIndex >= probe.videoCount) screenIndex = null;
      hasAudio = probe.hasAudio;
    }

    const boardVideo = await this._makeBoardVideo();

    const resolved = resolveOutputPath(RECORDINGS_DIR, this.room.id, this.startedAt || Date.now());
    this.outputPath = resolved.fullPath;
    this.outputName = resolved.name;

    // Richest first; each step removes whatever is most likely to be at fault.
    const attempts = [
      { label: "full", boardVideo, camIndex, screenIndex },
      { label: "no-screen", boardVideo, camIndex, screenIndex: null },
      { label: "no-board", boardVideo: null, camIndex, screenIndex },
      { label: "no-camera", boardVideo, camIndex: null, screenIndex },
      { label: "camera-only", boardVideo: null, camIndex, screenIndex: null },
      { label: "audio-only", boardVideo: null, camIndex: null, screenIndex: null },
    ];

    const tried = new Set();
    for (const attempt of attempts) {
      // An arrangement with nothing left to show and no audio is not a file.
      if (attempt.boardVideo == null && attempt.camIndex == null && attempt.screenIndex == null && !hasAudio) {
        continue;
      }
      // Dropping an element that was never captured produces the same command
      // twice; running it again would only fail again.
      const key = `${Boolean(attempt.boardVideo)}|${attempt.camIndex}|${attempt.screenIndex}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const res = await runFfmpeg(
        buildComposeArgs({
          livePath: this.livePath,
          boardVideo: attempt.boardVideo,
          outputPath: this.outputPath,
          camIndex: attempt.camIndex,
          screenIndex: attempt.screenIndex,
          hasAudio,
        }),
        `compose:${attempt.label}`,
        this.logPath,
      );

      const produced = fileSize(this.outputPath);
      if (res.ok && produced >= 2000) {
        this.layoutUsed = attempt.label;
        this.writeSidecar(attempt, hasAudio);
        log.info("compose done", {
          output: this.outputName,
          layout: attempt.label,
          bytes: produced,
        });
        return true;
      }

      log.warn(`compose ${attempt.label} failed — trying a simpler layout`, {
        code: res.code,
        bytes: produced,
        error: res.stderr.trim().split(/\r?\n/).slice(-3).join(" | "),
      });
      try {
        fs.rmSync(this.outputPath, { force: true });
      } catch {
        /* nothing to remove */
      }
    }

    log.error("every layout failed — see the ffmpeg log", { logPath: this.logPath });
    this.outputPath = null;
    this.outputName = null;
    return false;
  }

  writeSidecar(attempt, hasAudio) {
    try {
      const layout =
        attempt.screenIndex != null
          ? attempt.boardVideo
            ? "screen-main + board-inset"
            : "screen-main"
          : attempt.boardVideo
            ? "whiteboard-main"
            : "camera-main";
      fs.writeFileSync(
        path.join(RECORDINGS_DIR, `${this.outputName.replace(/\.mp4$/, "")}.json`),
        JSON.stringify(
          {
            id: this.id,
            meetingId: this.room.id,
            file: this.outputName,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            layout,
            attempt: attempt.label,
            hasAudio,
            hasCamera: attempt.camIndex != null,
            hasScreen: attempt.screenIndex != null,
            hasWhiteboard: Boolean(attempt.boardVideo),
            boardFrames: this.frameIndex,
            whiteboard: this.room.whiteboard || [],
          },
          null,
          2,
        ),
      );
    } catch (err) {
      log.error("could not write the sidecar", err);
    }
  }

  /**
   * Keeps the unlaid-out capture under a recognisable name when compose fails.
   * The audio and video are already in it and in sync; only the layout is
   * missing, so this is a usable recording rather than a lost class.
   */
  _preserveRawCapture() {
    try {
      if (!this.livePath || fileSize(this.livePath) < 2000) {
        log.warn("no capture to preserve");
        return;
      }
      const { name } = resolveOutputPath(
        RECORDINGS_DIR,
        `${this.room.id}_raw`,
        this.startedAt || Date.now(),
      );
      const rawName = name.replace(/\.mp4$/, ".mkv");
      const rawPath = path.join(RECORDINGS_DIR, rawName);
      fs.renameSync(this.livePath, rawPath);
      this.livePath = null;
      this.outputName = rawName;
      this.outputPath = rawPath;
      log.warn("kept the raw capture instead", { file: rawName, bytes: fileSize(rawPath) });
    } catch (err) {
      log.error("could not preserve the raw capture", err);
    }
  }

  /** Intermediates are only removed once the final file exists. */
  _cleanupIntermediates() {
    try {
      if (this.frameDir && fs.existsSync(this.frameDir)) {
        fs.rmSync(this.frameDir, { recursive: true, force: true });
      }
      // The ffmpeg log is deliberately kept: it is small, and it is the record
      // of how this recording was produced.
      for (const p of [this.sdpPath, this.livePath, this.boardVideoPath]) {
        if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    } catch (err) {
      log.error("cleanup failed (harmless)", err);
    }
  }

  /**
   * Ends the capture and returns as soon as the media has stopped.
   *
   * This is the half a teacher is waiting on when they press stop: a second or
   * two, not the minutes that laying out an hour of class can take. Repeat
   * calls join the run already in progress, so pressing stop again while it
   * works is harmless -- previously each press started another teardown and
   * another set of ffmpeg passes over the same files, which is what corrupted
   * the output and brought the server down.
   */
  async stopCapture() {
    if (this._captureStopPromise) return this._captureStopPromise;
    this._captureStopPromise = (async () => {
      log.action("stop capture", { recorderId: this.id, roomId: this.room.id });
      this.active = false;
      this.endedAt = Date.now();

      await this._stopIngest();

      for (const consumer of this.consumers) {
        try {
          consumer.close();
        } catch (err) {
          log.error("close consumer failed", err);
        }
      }
      for (const transport of this.transports) {
        try {
          transport.close();
        } catch (err) {
          log.error("close transport failed", err);
        }
      }
      this.consumers = [];
      this.transports = [];
      this.tracks.clear();

      log.info("capture ended", { recorderId: this.id, bytes: fileSize(this.livePath) });
      return this.snapshot();
    })();
    return this._captureStopPromise;
  }

  /**
   * Lays the capture out into the final file. Runs in the background, one at a
   * time across the server, and is likewise idempotent.
   */
  async finalize() {
    if (this._finalizePromise) return this._finalizePromise;
    this._finalizePromise = (async () => {
      await this.stopCapture();
      this.finalizing = true;
      try {
        return await queueCompose(async () => {
          let composed = false;
          try {
            composed = await this._compose();
          } catch (err) {
            log.error("compose failed", err);
          }
          if (composed) {
            this._cleanupIntermediates();
          } else {
            // Layout failed, but the capture itself is intact. Give it the same
            // name as the intended output so the class is findable and
            // downloadable rather than sitting in a temp file nobody knows about.
            this._preserveRawCapture();
          }
          this.composed = composed;
          log.info("cloud recording finalised", { output: this.outputName, composed });
          return this.snapshot();
        });
      } finally {
        this.finalizing = false;
      }
    })();
    return this._finalizePromise;
  }

  /** Stop and wait for the finished file. Used when the room is closing. */
  async stop() {
    await this.stopCapture();
    return this.finalize();
  }

  snapshot() {
    return {
      id: this.id,
      active: this.active,
      finalizing: this.finalizing,
      composed: this.composed,
      roomId: this.room.id,
      file: this.outputName,
      outputPath: this.outputPath,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      layout:
        this.screenIndex != null ? "screen-main + camera-inset" : "whiteboard-main + camera-inset",
    };
  }
}

module.exports = { CloudRecorder, RECORDINGS_DIR };
