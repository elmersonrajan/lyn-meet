const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");
const { appendMeetingLog } = require("../utils/meetingLog");

const log = createLogger("CloudRecorder");

const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || path.join(__dirname, "../../recordings"),
);

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error("ensureDir failed", dir, err);
    throw err;
  }
}

function pickPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function buildSdp({ audio, video }) {
  try {
    const lines = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=ClassroomMeet Cloud Recording",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
    ];
    if (audio) {
      lines.push(
        `m=audio ${audio.remoteRtpPort} RTP/AVP ${audio.payloadType}`,
        `a=rtpmap:${audio.payloadType} ${audio.codecName}/${audio.clockRate}/${audio.channels}`,
        "a=recvonly",
      );
    }
    if (video) {
      lines.push(
        `m=video ${video.remoteRtpPort} RTP/AVP ${video.payloadType}`,
        `a=rtpmap:${video.payloadType} ${video.codecName}/${video.clockRate}`,
        "a=recvonly",
      );
    }
    return `${lines.join("\n")}\n`;
  } catch (err) {
    log.error("buildSdp failed", err);
    throw err;
  }
}

function codecInfo(consumer) {
  try {
    const codec = consumer.rtpParameters.codecs[0];
    const [mimeKind, name] = codec.mimeType.split("/");
    return {
      kind: mimeKind,
      codecName: name,
      payloadType: codec.payloadType,
      clockRate: codec.clockRate,
      channels: codec.channels || 2,
    };
  } catch (err) {
    log.error("codecInfo failed", err);
    throw err;
  }
}

class CloudRecorder {
  constructor(room) {
    this.room = room;
    this.process = null;
    this.sdpPath = null;
    this.outputPath = null;
    this.startedAt = null;
    this.transports = [];
    this.consumers = [];
    this.active = false;
    this.mode = "none";
    this.rawPath = null;
    this.id = `rec_${Date.now()}`;
  }

  async start() {
    try {
      log.action("start", { roomId: this.room.id, recorderId: this.id });
      appendMeetingLog("recording start", { roomId: this.room.id, recorderId: this.id });
      ensureDir(RECORDINGS_DIR);

      const teacher = this.room.getTeacher();
      const audioProducer = teacher ? this.room.findProducer(teacher.id, "audio") : null;
      const videoProducer = teacher
        ? this.room.findProducer(teacher.id, "screen") || this.room.findProducer(teacher.id, "video")
        : null;

      this.outputPath = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.mp4`);
      this.active = true;
      this.startedAt = Date.now();

      if (!audioProducer && !videoProducer) {
        this.mode = "client-fallback";
        log.warn("NO audio/video/screen on SFU — Zoom-style: teacher browser will record cam/screen/whiteboard");
        appendMeetingLog("no sfu media — client fallback (whiteboard if no cam/screen)");
        return this.snapshot();
      }

      this.mode = "sfu-ffmpeg";
      const audioMeta = audioProducer ? await this._attachProducer(audioProducer) : null;
      const videoMeta = videoProducer ? await this._attachProducer(videoProducer) : null;
      if (!audioMeta) appendMeetingLog("WARN no audio track");
      if (!videoMeta) appendMeetingLog("WARN no video/screen track");

      this.sdpPath = path.join(RECORDINGS_DIR, `${this.id}.sdp`);
      fs.writeFileSync(this.sdpPath, buildSdp({ audio: audioMeta, video: videoMeta }), "utf8");

      const args = [
        "-y", "-loglevel", "warning",
        "-protocol_whitelist", "file,udp,rtp",
        "-fflags", "+genpts+discardcorrupt",
        "-analyzeduration", "8000000",
        "-probesize", "8000000",
        "-i", this.sdpPath,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        this.outputPath,
      ];
      this.process = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.process.stdout.on("data", (c) => log.info("ffmpeg stdout", String(c).trim()));
      this.process.stderr.on("data", (c) => {
        const msg = String(c).trim();
        log.info("ffmpeg", msg);
        appendMeetingLog("ffmpeg", { msg });
      });
      this.process.on("exit", (code, signal) => {
        log.info("ffmpeg exited", { code, signal, output: this.outputPath });
        appendMeetingLog("ffmpeg exit", { code, signal });
        this.active = false;
      });
      this.process.on("error", (err) => {
        log.error("ffmpeg process error", err);
        appendMeetingLog("ffmpeg error", { message: err.message });
        this.mode = "client-fallback";
      });

      for (const consumer of this.consumers) await consumer.resume();
      log.info("cloud recording started", { output: this.outputPath, mode: this.mode });
      return this.snapshot();
    } catch (err) {
      log.error("start failed — falling back to client capture", err);
      appendMeetingLog("start failed", { message: err.message });
      this.mode = "client-fallback";
      this.active = true;
      this.startedAt = Date.now();
      this.outputPath = this.outputPath || path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.mp4`);
      return this.snapshot();
    }
  }

  async _attachProducer(producer) {
    try {
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
        producerId: producer.id, kind: producer.kind, remoteRtpPort, codec: info.codecName,
      });
      appendMeetingLog("sfu consumer", { kind: producer.kind, codec: info.codecName });
      return { ...info, remoteRtpPort };
    } catch (err) {
      log.error("_attachProducer failed", err);
      appendMeetingLog("attach producer failed", { message: err.message });
      throw err;
    }
  }

  async ingestClientBlob(buffer, contentType) {
    try {
      ensureDir(RECORDINGS_DIR);
      const ext = (contentType || "").includes("mp4") ? "mp4" : "webm";
      const rawPath = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}_raw.${ext}`);
      fs.writeFileSync(rawPath, buffer);
      log.info("saved teacher browser capture", { rawPath, bytes: buffer.length, contentType });
      appendMeetingLog("client capture saved", { rawPath, bytes: buffer.length });

      this.outputPath = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.mp4`);
      await new Promise((resolve, reject) => {
        try {
          const ff = spawn("ffmpeg", [
            "-y", "-loglevel", "warning", "-i", rawPath,
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            this.outputPath,
          ], { stdio: ["ignore", "pipe", "pipe"] });
          ff.stderr.on("data", (c) => log.info("ffmpeg convert", String(c).trim()));
          ff.on("error", reject);
          ff.on("exit", (code) => {
            if (code === 0) resolve();
            else {
              log.warn("ffmpeg convert failed, keeping raw", { code, rawPath });
              this.outputPath = rawPath;
              resolve();
            }
          });
        } catch (err) {
          reject(err);
        }
      });
      return this.snapshot();
    } catch (err) {
      log.error("ingestClientBlob failed", err);
      appendMeetingLog("ingest failed", { message: err.message });
      throw err;
    }
  }

  async appendChunk(buffer) {
    try {
      ensureDir(RECORDINGS_DIR);
      if (!buffer || !buffer.length) {
        log.warn("empty chunk skipped");
        return this.snapshot();
      }
      this.rawPath = this.rawPath || path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.webm`);
      fs.appendFileSync(this.rawPath, buffer);
      log.info("chunk appended (teacher still online)", {
        bytes: buffer.length,
        total: fs.statSync(this.rawPath).size,
        rawPath: this.rawPath,
      });
      appendMeetingLog("chunk", { bytes: buffer.length, total: fs.statSync(this.rawPath).size });
      this.outputPath = this.rawPath;
      return this.snapshot();
    } catch (err) {
      log.error("appendChunk failed", err);
      appendMeetingLog("chunk failed", { message: err.message });
      throw err;
    }
  }

  async finalizeRaw() {
    try {
      if (!this.rawPath || !fs.existsSync(this.rawPath)) {
        log.warn("finalize: no webm yet (teacher dropped before first chunk?)");
        appendMeetingLog("finalize no webm");
        return this.snapshot();
      }
      const mp4Path = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.mp4`);
      log.info("finalize converting webm → mp4", { from: this.rawPath, to: mp4Path });
      await new Promise((resolve) => {
        try {
          const ff = spawn("ffmpeg", [
            "-y", "-loglevel", "warning", "-i", this.rawPath,
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            mp4Path,
          ], { stdio: ["ignore", "pipe", "pipe"] });
          ff.stderr.on("data", (c) => log.info("ffmpeg finalize", String(c).trim()));
          ff.on("error", (err) => {
            log.error("ffmpeg finalize spawn", err);
            resolve();
          });
          ff.on("exit", (code) => {
            if (code === 0) {
              this.outputPath = mp4Path;
              log.info("mp4 ready", { mp4Path });
            } else {
              log.warn("keep webm, ffmpeg finalize code", code);
              this.outputPath = this.rawPath;
            }
            resolve();
          });
        } catch (err) {
          log.error("finalizeRaw ffmpeg", err);
          resolve();
        }
      });
      return this.snapshot();
    } catch (err) {
      log.error("finalizeRaw failed", err);
      throw err;
    }
  }


    try {
      log.action("stop", { recorderId: this.id, roomId: this.room.id });
      appendMeetingLog("recording stop", { recorderId: this.id });
      this.active = false;
      try {
        await this.finalizeRaw();
      } catch (err) {
        log.error("stop finalizeRaw", err);
      }
      if (this.process && !this.process.killed) {
        this.process.kill("SIGINT");
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 2500);
          this.process.once("exit", () => { clearTimeout(t); resolve(); });
        });
      }
      for (const consumer of this.consumers) {
        try { consumer.close(); } catch (err) { log.error("close consumer failed", err); }
      }
      for (const transport of this.transports) {
        try { transport.close(); } catch (err) { log.error("close transport failed", err); }
      }
      this.consumers = [];
      this.transports = [];
      log.info("cloud recording stopped", { output: this.outputPath });
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
      mode: this.mode,
      outputPath: this.outputPath,
      startedAt: this.startedAt,
      roomId: this.room.id,
    };
  }
}

module.exports = { CloudRecorder, RECORDINGS_DIR };
