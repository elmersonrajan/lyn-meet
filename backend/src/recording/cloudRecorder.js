const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");
const { writeBoardFrame } = require("./whiteboardFrame");
const { resolveOutputPath } = require("./recordingName");
const { buildSdp, buildIngestArgs, buildComposeArgs } = require("./ffmpegArgs");

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

function pickPort() {
  return 20000 + Math.floor(Math.random() * 20000);
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

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    log.info(`ffmpeg ${label}`, args.join(" "));
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let errText = "";
    proc.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) log.info(`ffmpeg ${label}`, line);
      errText += `${line}\n`;
    });
    proc.on("error", (err) => reject(err));
    proc.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${code || signal}): ${errText.slice(-400)}`));
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the streams that actually landed in the captured file.
 *
 * Attaching a producer does not guarantee a stream: a camera that was off, or a
 * screen share that stopped, sends no RTP and leaves no track behind. Building
 * the layout from what was *attached* rather than what arrived makes the filter
 * graph reference a stream that does not exist, and ffmpeg then writes a 0-byte
 * output. So the file is asked what it contains.
 */
function probeStreams(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=index,codec_type", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout.on("data", (c) => (out += String(c)));
    proc.on("error", (err) => {
      log.warn("ffprobe unavailable — falling back to attached streams", err.message);
      resolve(null);
    });
    proc.on("exit", () => {
      const types = out
        .split("\n")
        .map((line) => line.trim().split(",")[1])
        .filter(Boolean);
      if (!types.length) {
        resolve(null);
        return;
      }
      resolve({
        videoCount: types.filter((t) => t === "video").length,
        hasAudio: types.includes("audio"),
      });
    });
  });
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

    this.ingestProc = null;
    this.transports = [];
    this.consumers = [];

    this.sdpPath = null;
    this.livePath = null;
    this.outputPath = null;
    this.outputName = null;

    this.frameDir = null;
    this.frameTimer = null;
    this.frameIndex = 0;

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

      const audio = audioProducer ? await this._attach(audioProducer) : null;
      const cam = camProducer ? await this._attach(camProducer) : null;
      const screen = screenProducer ? await this._attach(screenProducer) : null;

      this.hasAudio = Boolean(audio);
      // Video stream indexes within the output, in SDP order.
      let v = 0;
      this.camIndex = cam ? v++ : null;
      this.screenIndex = screen ? v++ : null;

      this.frameDir = path.join(RECORDINGS_DIR, `${this.id}_frames`);
      ensureDir(this.frameDir);
      this.sdpPath = path.join(RECORDINGS_DIR, `${this.id}.sdp`);
      this.livePath = path.join(RECORDINGS_DIR, `${this.id}_live.mkv`);

      fs.writeFileSync(this.sdpPath, buildSdp({ audio, cam, screen }), "utf8");

      const args = buildIngestArgs({
        sdpPath: this.sdpPath,
        outputPath: this.livePath,
        hasAudio: this.hasAudio,
      });
      log.info("ffmpeg ingest", args.join(" "));
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
      await this.stop().catch(() => {});
      throw err;
    }
  }

  async _attach(producer) {
    const remoteRtpPort = pickPort();
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
    log.info("recording consumer attached", {
      kind: producer.kind,
      source: producer.appData?.source,
      remoteRtpPort,
      codec: info.codecName,
    });
    return { ...info, remoteRtpPort };
  }

  _writeBoardSnapshot() {
    try {
      const name = `board_${String(this.frameIndex).padStart(6, "0")}.ppm`;
      writeBoardFrame(path.join(this.frameDir, name), this.room.whiteboard || []);
      this.frameIndex += 1;
    } catch (err) {
      log.error("board snapshot failed", err);
    }
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

  async _compose() {
    const live = fileSize(this.livePath);
    if (live < 2000) {
      log.warn("nothing captured — skipping compose", { livePath: this.livePath, bytes: live });
      return false;
    }

    const resolved = resolveOutputPath(RECORDINGS_DIR, this.room.id, this.startedAt || Date.now());
    this.outputPath = resolved.fullPath;
    this.outputName = resolved.name;

    const boardPattern =
      this.frameIndex > 0 ? path.join(this.frameDir, "board_%06d.ppm") : null;

    // Trust the file over our own bookkeeping: clamp the declared stream
    // indexes to the streams that actually arrived.
    const probe = await probeStreams(this.livePath);
    let camIndex = this.camIndex;
    let screenIndex = this.screenIndex;
    let hasAudio = this.hasAudio;
    if (probe) {
      log.info("probed capture", probe);
      if (camIndex != null && camIndex >= probe.videoCount) camIndex = null;
      if (screenIndex != null && screenIndex >= probe.videoCount) screenIndex = null;
      hasAudio = probe.hasAudio;
      if (probe.videoCount === 0) {
        log.warn("capture has no video track — recording audio and board only");
      }
    }

    const args = buildComposeArgs({
      livePath: this.livePath,
      boardPattern,
      outputPath: this.outputPath,
      camIndex,
      screenIndex,
      hasAudio,
      boardFps: BOARD_FPS,
    });

    await runFfmpeg(args, "compose");

    // A compose that exits 0 but writes nothing must not be reported as
    // success, and must never be left behind as a 0-byte file.
    const produced = fileSize(this.outputPath);
    if (produced < 2000) {
      log.error("compose produced an empty file — removing it", {
        output: this.outputName,
        bytes: produced,
      });
      try {
        fs.rmSync(this.outputPath, { force: true });
      } catch {
        /* nothing to remove */
      }
      this.outputPath = null;
      this.outputName = null;
      return false;
    }

    const layout =
      this.screenIndex != null ? "screen-main + camera-inset" : "whiteboard-main + camera-inset";
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
          hasAudio: this.hasAudio,
          boardFrames: this.frameIndex,
          whiteboard: this.room.whiteboard || [],
        },
        null,
        2,
      ),
    );
    log.info("compose done", { output: this.outputName, layout, bytes: fileSize(this.outputPath) });
    return true;
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
      for (const p of [this.sdpPath, this.livePath]) {
        if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    } catch (err) {
      log.error("cleanup failed (harmless)", err);
    }
  }

  async stop() {
    try {
      log.action("stop", { recorderId: this.id, roomId: this.room.id });
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
        // name as the intended output so the class is findable and downloadable
        // rather than sitting in a temp file nobody knows about.
        this._preserveRawCapture();
      }

      log.info("cloud recording stopped", { output: this.outputName, composed });
      return this.snapshot();
    } catch (err) {
      log.error("stop failed", err);
      throw err;
    }
  }

  snapshot() {
    return {
      id: this.id,
      active: this.active,
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
