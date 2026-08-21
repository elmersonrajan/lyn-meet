const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");
const { writeBoardFrame } = require("./whiteboardFrame");

const log = createLogger("CloudRecorder");

const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || path.join(__dirname, "../../recordings"),
);

const LAYOUT_W = 1280;
const LAYOUT_H = 720;
const PIP_W = 280;
const PIP_H = 158;

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

function fileSize(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch (err) {
    log.error("fileSize failed", filePath, err);
    return 0;
  }
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

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    try {
      log.info(`ffmpeg ${label}`, args.join(" "));
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      let errText = "";
      proc.stderr.on("data", (chunk) => {
        const line = String(chunk).trim();
        if (line) log.info(`ffmpeg ${label}`, line);
        errText += `${line}\n`;
      });
      proc.on("error", (err) => {
        log.error(`ffmpeg ${label} process error`, err);
        reject(err);
      });
      proc.on("exit", (code, signal) => {
        log.info(`ffmpeg ${label} exited`, { code, signal });
        if (code === 0) resolve();
        else reject(new Error(`${label} failed (${code || signal}): ${errText.slice(-400)}`));
      });
    } catch (err) {
      log.error(`runFfmpeg ${label} failed`, err);
      reject(err);
    }
  });
}

class CloudRecorder {
  constructor(room) {
    this.room = room;
    this.processes = [];
    this.sdpPath = null;
    this.screenSdpPath = null;
    this.camPath = null;
    this.screenPath = null;
    this.outputPath = null;
    this.startedAt = null;
    this.transports = [];
    this.consumers = [];
    this.active = false;
    this.id = `rec_${Date.now()}`;
    this.frameDir = null;
    this.frameTimer = null;
    this.frameIndex = 0;
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
      const camProducer = this.room.findProducer(teacher.id, "video");
      const screenProducer = this.room.findProducer(teacher.id, "screen");

      this.frameDir = path.join(RECORDINGS_DIR, `${this.id}_frames`);
      ensureDir(this.frameDir);
      this.camPath = path.join(RECORDINGS_DIR, `${this.id}_cam.mp4`);
      this.screenPath = path.join(RECORDINGS_DIR, `${this.id}_screen.mp4`);
      this.outputPath = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.mp4`);

      const audioMeta = audioProducer ? await this._attachProducer(audioProducer) : null;
      const camMeta = camProducer ? await this._attachProducer(camProducer) : null;
      const screenMeta = screenProducer ? await this._attachProducer(screenProducer) : null;

      this.sdpPath = path.join(RECORDINGS_DIR, `${this.id}_cam.sdp`);
      fs.writeFileSync(this.sdpPath, buildSdp({ audio: audioMeta, video: camMeta }), "utf8");

      this.processes.push(this._spawnIngest(this.sdpPath, this.camPath, "cam"));

      if (screenMeta) {
        this.screenSdpPath = path.join(RECORDINGS_DIR, `${this.id}_screen.sdp`);
        fs.writeFileSync(this.screenSdpPath, buildSdp({ video: screenMeta }), "utf8");
        this.processes.push(this._spawnIngest(this.screenSdpPath, this.screenPath, "screen"));
      }

      this.active = true;
      this.startedAt = Date.now();
      this._writeBoardSnapshot();
      this.frameTimer = setInterval(() => this._writeBoardSnapshot(), 1000);

      for (const consumer of this.consumers) {
        await consumer.resume();
      }

      log.info("cloud recording started", {
        output: this.outputPath,
        roomId: this.room.id,
        layout: "board-main + camera-pip",
      });

      return this.snapshot();
    } catch (err) {
      log.error("start failed", err);
      await this.stop().catch(() => {});
      throw err;
    }
  }

  _spawnIngest(sdpPath, outputPath, label) {
    const args = [
      "-y",
      "-loglevel",
      "warning",
      "-protocol_whitelist",
      "file,udp,rtp",
      "-fflags",
      "+genpts+discardcorrupt",
      "-i",
      sdpPath,
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
      outputPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (chunk) => {
      log.info(`ffmpeg ${label}`, String(chunk).trim());
    });
    proc.on("exit", (code, signal) => {
      log.info(`ffmpeg ${label} ingest exited`, { code, signal, output: outputPath });
    });
    proc.on("error", (err) => {
      log.error(`ffmpeg ${label} ingest error — is ffmpeg installed?`, err);
    });
    return proc;
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
        source: producer.appData && producer.appData.source,
        remoteRtpPort,
        codec: info.codecName,
      });

      return { ...info, remoteRtpPort };
    } catch (err) {
      log.error("_attachProducer failed", err);
      throw err;
    }
  }

  async _stopIngest() {
    try {
      if (this.frameTimer) {
        clearInterval(this.frameTimer);
        this.frameTimer = null;
      }
      this._writeBoardSnapshot();

      const waiting = this.processes.map(
        (proc) =>
          new Promise((resolve) => {
            if (!proc || proc.killed) {
              resolve();
              return;
            }
            const t = setTimeout(resolve, 2500);
            proc.once("exit", () => {
              clearTimeout(t);
              resolve();
            });
            try {
              proc.kill("SIGINT");
            } catch (err) {
              log.error("kill ingest failed", err);
              resolve();
            }
          }),
      );
      this.processes = [];
      await Promise.all(waiting);
    } catch (err) {
      log.error("_stopIngest failed", err);
    }
  }

  async _composeLayout() {
    try {
      if (this.frameIndex < 1) this._writeBoardSnapshot();

      const firstFrame = path.join(this.frameDir, "board_%06d.ppm");
      const hasCam = fileSize(this.camPath) > 2000;
      const hasScreen = fileSize(this.screenPath) > 2000;
      const useScreen = hasScreen && this.room.stageMode === "screen";

      const bgScale =
        `scale=${LAYOUT_W}:${LAYOUT_H}:force_original_aspect_ratio=decrease,` +
        `pad=${LAYOUT_W}:${LAYOUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[bg]`;

      const args = ["-y", "-loglevel", "warning"];

      if (useScreen) {
        args.push("-i", this.screenPath);
      } else {
        args.push("-framerate", "1", "-i", firstFrame);
      }

      if (hasCam) args.push("-i", this.camPath);

      if (hasCam) {
        args.push(
          "-filter_complex",
          `[0:v]${bgScale};` +
            `[1:v]scale=${PIP_W}:${PIP_H}:force_original_aspect_ratio=decrease,` +
            `pad=${PIP_W}:${PIP_H}:(ow-iw)/2:(oh-ih)/2,setsar=1[pip];` +
            `[bg][pip]overlay=W-w-24:H-h-24:eof_action=pass[v]`,
          "-map",
          "[v]",
          "-map",
          "1:a?",
        );
      } else {
        args.push("-filter_complex", `[0:v]${bgScale}`, "-map", "[bg]");
      }

      args.push(
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
        "-shortest",
        "-movflags",
        "+faststart",
        this.outputPath,
      );

      await runFfmpeg(args, "compose");

      const sidecar = path.join(RECORDINGS_DIR, `${this.room.id}_${this.id}.json`);
      fs.writeFileSync(
        sidecar,
        JSON.stringify(
          {
            id: this.id,
            roomId: this.room.id,
            startedAt: this.startedAt,
            endedAt: Date.now(),
            layout: useScreen ? "screen-main + camera-pip" : "whiteboard-main + camera-pip",
            whiteboard: this.room.whiteboard || [],
            outputPath: this.outputPath,
          },
          null,
          2,
        ),
      );
      log.info("layout compose done", { output: this.outputPath, useScreen, hasCam });
    } catch (err) {
      log.error("compose layout failed — leaving ingest files", err);
    }
  }

  async stop() {
    try {
      log.action("stop", { recorderId: this.id, roomId: this.room.id });
      this.active = false;

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

      await this._composeLayout();

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
      layout: "whiteboard-or-screen-main + camera-pip",
    };
  }
}

module.exports = { CloudRecorder, RECORDINGS_DIR };
