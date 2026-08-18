const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");

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
    this.id = `rec_${Date.now()}`;
  }

  async start() {
    try {
      log.action("start", { roomId: this.room.id, recorderId: this.id });
      ensureDir(RECORDINGS_DIR);

      const teacher = this.room.getTeacher();
      if (!teacher) {
        throw new Error("Cannot start cloud recording without a teacher in the room");
      }

      const audioProducer = this.room.findProducer(teacher.id, "audio");
      const videoProducer =
        this.room.findProducer(teacher.id, "screen") ||
        this.room.findProducer(teacher.id, "video");

      if (!audioProducer && !videoProducer) {
        throw new Error("Teacher has no media to record yet. Enable camera or screen first.");
      }

      const audioMeta = audioProducer
        ? await this._attachProducer(audioProducer)
        : null;
      const videoMeta = videoProducer
        ? await this._attachProducer(videoProducer)
        : null;

      this.sdpPath = path.join(RECORDINGS_DIR, `${this.id}.sdp`);
      this.outputPath = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.mp4`);
      fs.writeFileSync(
        this.sdpPath,
        buildSdp({ audio: audioMeta, video: videoMeta }),
        "utf8",
      );

      const args = [
        "-y",
        "-loglevel",
        "warning",
        "-protocol_whitelist",
        "file,udp,rtp",
        "-fflags",
        "+genpts+discardcorrupt",
        "-i",
        this.sdpPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        this.outputPath,
      ];

      this.process = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.active = true;
      this.startedAt = Date.now();

      this.process.stdout.on("data", (chunk) => {
        log.info("ffmpeg stdout", String(chunk).trim());
      });
      this.process.stderr.on("data", (chunk) => {
        log.info("ffmpeg", String(chunk).trim());
      });
      this.process.on("exit", (code, signal) => {
        log.info("ffmpeg exited", { code, signal, output: this.outputPath });
        this.active = false;
      });
      this.process.on("error", (err) => {
        log.error("ffmpeg process error — is ffmpeg installed?", err);
        this.active = false;
      });

      for (const consumer of this.consumers) {
        await consumer.resume();
      }

      log.info("cloud recording started", {
        output: this.outputPath,
        roomId: this.room.id,
      });

      return this.snapshot();
    } catch (err) {
      log.error("start failed", err);
      await this.stop().catch(() => {});
      throw err;
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
        producerId: producer.id,
        kind: producer.kind,
        remoteRtpPort,
        codec: info.codecName,
      });

      return { ...info, remoteRtpPort };
    } catch (err) {
      log.error("_attachProducer failed", err);
      throw err;
    }
  }

  async stop() {
    try {
      log.action("stop", { recorderId: this.id, roomId: this.room.id });
      this.active = false;

      if (this.process && !this.process.killed) {
        this.process.kill("SIGINT");
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 2500);
          this.process.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }

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
      outputPath: this.outputPath,
      startedAt: this.startedAt,
      roomId: this.room.id,
    };
  }
}

module.exports = { CloudRecorder, RECORDINGS_DIR };
