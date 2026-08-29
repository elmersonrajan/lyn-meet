const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createLogger } = require("../utils/logger");
const { writeBoardFrame } = require("./whiteboardFrame");
const { buildSdp, buildIngestArgs } = require("./ffmpegArgs");
const { RECORDINGS_DIR, ensureDir, fileSize } = require("./paths");
const renderQueue = require("./renderQueue");

const log = createLogger("CloudRecorder");

const BOARD_FPS = Number(process.env.RECORDING_BOARD_FPS || 1);
// Long enough for ffmpeg to bind its UDP sockets before any RTP is sent.
const INGEST_WARMUP_MS = Number(process.env.RECORDING_WARMUP_MS || 700);
// A ceiling on side captures, so a room where everyone unmutes cannot spawn an
// unbounded number of ffmpeg processes.
const MAX_SIDES = Number(process.env.RECORDING_MAX_SIDES || 12);

/**
 * Ports are handed out in sequence, two at a time, rather than at random: each
 * stream needs an even port for RTP and the odd one above it for RTCP, and two
 * sources -- or two rooms recording at once -- must never collide.
 */
let nextPort = 20000;
function pickPort() {
  nextPort = nextPort >= 39996 ? 20000 : nextPort + 2;
  return nextPort;
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Captures a class. Only captures it.
 *
 * Recording is two jobs with very different shapes, and running them as one is
 * what made stopping feel broken. Capture is live: it has to keep up with the
 * room, and it ends the moment the teacher says so. Rendering is heavy, slow,
 * and cares about nothing but files. So this class does the first, writes down
 * what it produced, and hands that description to the background queue -- see
 * renderQueue. Stopping is then a second or two, and the teacher can leave.
 *
 * Within capture:
 *
 *   - ONE ffmpeg reads every stream the teacher had when recording began,
 *     through a single SDP, into one Matroska file. One process means one
 *     clock, so audio, camera and screen stay in step by construction.
 *   - Anything that starts later -- a student unmuting, a screen share -- gets
 *     a small capture of its own, stamped from the same server clock, and is
 *     put back in its place at render time using the offset between the two.
 *   - The whiteboard is not a video stream at all: it is re-drawn from the
 *     stroke list on a timer, and the frames carry their real durations.
 */
class CloudRecorder {
  constructor(room) {
    this.room = room;
    this.id = `rec_${Date.now()}`;
    this.room_id = room.id;
    this.active = false;
    this.startedAt = null;
    this.endedAt = null;
    this.status = "idle";
    // Repeat calls to stop join the run already in progress rather than
    // starting a second teardown of the same files.
    this._captureStopPromise = null;
    this.job = null;

    this.ingestProc = null;
    this.transports = [];
    this.consumers = [];
    // source -> { remoteRtpPort, payloadType, consumer, producerId }, so a
    // producer replaced mid-class can be reconnected to the port ffmpeg is
    // already reading.
    this.tracks = new Map();
    // Anything that started after the class was already recording.
    this.sides = [];

    this.sdpPath = null;
    this.livePath = null;
    // Every ffmpeg command and its full output, kept beside the recording so a
    // failure can be diagnosed without digging through the server log.
    this.logPath = null;

    this.frameDir = null;
    this.frameTimer = null;
    this.frameIndex = 0;
    // { name, at } per board frame, in order. The gaps between them are the
    // frame durations written into the concat manifest.
    this.frames = [];
    this.lastBoardSignature = null;

    this.captureStartedAt = null;
    // The moment media actually began flowing. This is time zero for the
    // finished file: the board and every side capture are placed relative to it.
    this.mediaStartedAt = null;

    // Stream order inside the ingest file, needed by the render layout.
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
      // A coordinator shares their screen as readily as the teacher does, and
      // only the teacher's was ever looked for.
      const screenPeer = this.room.getStaff().find((p) => this.room.findProducer(p.id, "screen"));
      const screenProducer = screenPeer ? this.room.findProducer(screenPeer.id, "screen") : null;

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
      this.status = "recording";
      this.startedAt = Date.now();
      this.mediaStartedAt = Date.now();
      this._writeBoardSnapshot();
      this.frameTimer = setInterval(() => this._writeBoardSnapshot(), 1000 / BOARD_FPS);

      // Anyone already unmuted when recording began. Started without waiting so
      // pressing record stays instant; each capture carries its own offset, so
      // arriving a moment late costs a second of that voice, not its place.
      for (const peer of this.room.peers.values()) {
        if (peer.id === teacher.id || peer.disconnected || peer.audioMuted) continue;
        this.addVoice(peer).catch((err) => log.error("seed voice failed", err));
      }

      log.info("cloud recording started", {
        roomId: this.room.id,
        streams: {
          audio: this.hasAudio,
          cam: this.camIndex != null,
          screen: this.screenIndex != null,
        },
      });
      return this.snapshot();
    } catch (err) {
      log.error("start failed", err);
      // Release the ports and transports, but queue nothing: there is no
      // capture to render.
      await this._teardown().catch(() => {});
      throw err;
    }
  }

  /**
   * Connects one producer to a pair of ports ffmpeg is reading.
   *
   * RTCP goes to its own port, one above the RTP port. It used to share the RTP
   * port, which mediasoup is happy to do but the SDP never declared -- so
   * ffmpeg read every sender report as if it were media. An RTCP header where a
   * sequence number should be produced enormous apparent gaps ("RTP: missed
   * 7822 packets"), the reordering queue thrashed, and real packets were
   * dropped: the several-second freezes in the finished recording, arriving at
   * roughly the interval RTCP is sent.
   *
   * The port is chosen once per source and reused for the rest of the class,
   * because the SDP ffmpeg started with is fixed and a replacement producer has
   * to arrive on the same port to be picked up.
   */
  async _attach(producer, source, remoteRtpPort = pickPort()) {
    const transport = await this.room.router.createPlainTransport({
      listenInfo: { protocol: "udp", ip: "127.0.0.1" },
      rtcpMux: false,
      comedia: false,
    });
    this.transports.push(transport);
    await transport.connect({
      ip: "127.0.0.1",
      port: remoteRtpPort,
      rtcpPort: remoteRtpPort + 1,
    });

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.room.router.rtpCapabilities,
      paused: true,
    });
    this.consumers.push(consumer);

    const info = codecInfo(consumer);
    this.tracks.set(source, { ...info, remoteRtpPort, consumer, producerId: producer.id });

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
   * Captures one stream that began after recording had already started.
   *
   * The main capture reads a single SDP that ffmpeg parses once, so no stream
   * can be added to it later. Rather than restart the class recording, each
   * latecomer gets a small ffmpeg of its own. Both are stamped from the same
   * server clock, so the gap between the two start moments is all the renderer
   * needs to put it back in the right place.
   */
  async _startSide({ producer, peer, kind }) {
    const index = this.sides.length;
    const port = pickPort();
    const transport = await this.room.router.createPlainTransport({
      listenInfo: { protocol: "udp", ip: "127.0.0.1" },
      rtcpMux: false,
      comedia: false,
    });
    this.transports.push(transport);
    await transport.connect({ ip: "127.0.0.1", port, rtcpPort: port + 1 });

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.room.router.rtpCapabilities,
      paused: true,
    });
    this.consumers.push(consumer);

    const info = { ...codecInfo(consumer), remoteRtpPort: port };
    const sdpPath = path.join(RECORDINGS_DIR, `${this.id}_side${index}.sdp`);
    const outPath = path.join(RECORDINGS_DIR, `${this.id}_side${index}.mkv`);
    fs.writeFileSync(sdpPath, buildSdp(kind === "audio" ? { audio: info } : { cam: info }), "utf8");

    const args = buildIngestArgs({ sdpPath, outputPath: outPath, hasAudio: kind === "audio" });
    log.info("ffmpeg side", args.join(" "));
    const startedAt = Date.now();
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => {
      const line = String(c).trim();
      if (line) log.info(`ffmpeg side:${kind}`, line);
    });
    proc.on("error", (err) => log.error("ffmpeg side error", err));

    await wait(INGEST_WARMUP_MS);
    await consumer.resume();
    if (kind === "video") {
      try {
        await consumer.requestKeyFrame();
      } catch (err) {
        log.warn("side requestKeyFrame failed (continuing)", err.message);
      }
    }

    const side = {
      kind,
      path: outPath,
      sdpPath,
      proc,
      peerId: peer.id,
      name: peer.name,
      role: peer.role,
      producerId: producer.id,
      // Where this belongs in the finished file, measured from the moment the
      // class recording itself began.
      offsetMs: Math.max(0, startedAt - (this.mediaStartedAt || startedAt)),
    };
    this.sides.push(side);
    log.info("side capture started", {
      kind,
      name: peer.name,
      role: peer.role,
      offsetMs: side.offsetMs,
    });
    return side;
  }

  /**
   * Records a student or coordinator who is speaking.
   *
   * Only the teacher was ever recorded, so a class played back later had the
   * teacher answering questions nobody could hear. The capture is left running
   * once it starts: someone who mutes and unmutes again simply sends nothing in
   * between, which is cheaper and safer than tearing it down and rebuilding it.
   */
  async addVoice(peer) {
    try {
      if (!this.active || !peer || peer.disconnected) return null;
      const teacher = this.room.getTeacher();
      if (teacher && peer.id === teacher.id) return null;
      if (this.sides.some((s) => s.kind === "audio" && s.peerId === peer.id)) return null;
      if (this.sides.length >= MAX_SIDES) {
        log.warn("voice not recorded — too many side captures already", {
          name: peer.name,
          max: MAX_SIDES,
        });
        return null;
      }
      const producer = this.room.findProducer(peer.id, "audio");
      if (!producer) return null;
      return await this._startSide({ producer, peer, kind: "audio" });
    } catch (err) {
      log.error("addVoice failed — recording continues without that voice", err);
      return null;
    }
  }

  /**
   * Records a screen share that began after the class was already recording,
   * whoever is sharing.
   */
  async addScreen(peer) {
    try {
      if (!this.active || !peer) return null;
      // A share running at start already has a place in the main capture.
      if (this.tracks.has("screen")) return null;
      if (this.sides.some((s) => s.kind === "video")) return null;
      if (this.sides.length >= MAX_SIDES) return null;
      const producer = this.room.findProducer(peer.id, "screen");
      if (!producer) return null;
      return await this._startSide({ producer, peer, kind: "video" });
    } catch (err) {
      log.error("addScreen failed — recording continues without the share", err);
      return null;
    }
  }

  /**
   * Told by the room whenever a producer appears, so a recording in progress
   * can follow what is actually being published.
   */
  async onProducerAdded(peer, producer) {
    try {
      if (!this.active || !peer) return;
      const source = producer.appData?.source;
      const track = this.tracks.get(source);

      // A source that had a port reserved in the SDP goes back to that port.
      // The owner has to match, or a student's microphone would be spliced into
      // the slot the teacher's was recorded on.
      const teacher = this.room.getTeacher();
      const owner =
        source === "screen"
          ? peer.role === "teacher" || peer.role === "coordinator"
          : Boolean(teacher) && peer.id === teacher.id;

      if (track && !track.consumer && owner) {
        await this._reattach(producer, source, track);
        return;
      }
      // Voices are picked up when somebody unmutes, not here: a producer is
      // created muted.
      if (source === "screen") await this.addScreen(peer);
    } catch (err) {
      log.error("onProducerAdded failed — recording continues", err);
    }
  }

  /**
   * Reconnects a recorded source to a producer that replaced the original.
   *
   * A teacher who drops and rejoins publishes a brand new camera and mic; the
   * recorder was bound to the old ones and never looked again, so the teacher
   * reappeared in the meeting but vanished from the recording.
   */
  async _reattach(producer, source, track) {
    try {
      const replacement = await this.room.router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: "127.0.0.1" },
        rtcpMux: false,
        comedia: false,
      });
      this.transports.push(replacement);
      await replacement.connect({
        ip: "127.0.0.1",
        port: track.remoteRtpPort,
        rtcpPort: track.remoteRtpPort + 1,
      });

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
   * A fixed frame rate assumed the snapshot timer fired exactly on schedule,
   * and it does not on a box also running the SFU and an ffmpeg ingest; every
   * late tick shortened the board against the audio.
   *
   * @returns {string|null} the manifest path, or null if there is nothing to build
   */
  _writeBoardManifest() {
    if (!this.frames.length) return null;
    const endedAt = this.endedAt || Date.now();
    const startAt = this.mediaStartedAt || this.frames[0].at;
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
  _endProcess(proc) {
    return new Promise((resolve) => {
      if (!proc || proc.killed) return resolve();
      const timeout = setTimeout(() => {
        log.warn("a capture did not exit in time — forcing");
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
        log.error("kill failed", err);
        resolve();
      }
    });
  }

  /** Stops every ffmpeg and releases every transport. No files are touched. */
  async _teardown() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.frameDir) this._writeBoardSnapshot();

    const ingest = this.ingestProc;
    this.ingestProc = null;
    const sideProcs = this.sides.map((s) => {
      const proc = s.proc;
      s.proc = null;
      return proc;
    });
    await Promise.all([ingest, ...sideProcs].map((p) => this._endProcess(p)));

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
  }

  /** The description the background renderer works from. Plain data only. */
  _buildJob() {
    return {
      id: this.id,
      meetingId: this.room.id,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      livePath: this.livePath,
      logPath: this.logPath,
      sdpPaths: [this.sdpPath],
      frameDir: this.frameDir,
      boardManifest: this._writeBoardManifest(),
      camIndex: this.camIndex,
      screenIndex: this.screenIndex,
      hasAudio: this.hasAudio,
      sides: this.sides.map((s) => ({
        kind: s.kind,
        path: s.path,
        sdpPath: s.sdpPath,
        offsetMs: s.offsetMs,
        name: s.name,
        role: s.role,
      })),
      whiteboard: this.room.whiteboard || [],
    };
  }

  /**
   * Ends the capture and hands it to the background queue.
   *
   * This is the whole of what a teacher waits for when they press stop: the
   * ffmpeg processes are closed cleanly so the files are readable, and a job
   * describing them is written to disk. A second or two, not the minutes that
   * laying out an hour of class takes. Everything after this point survives the
   * teacher leaving, the room closing, and the server restarting.
   *
   * Repeat calls join the run already in progress, so pressing stop again is
   * harmless.
   */
  async stopCapture() {
    if (this._captureStopPromise) return this._captureStopPromise;
    this._captureStopPromise = (async () => {
      log.action("stop capture", { recorderId: this.id, roomId: this.room.id });
      this.active = false;
      this.endedAt = Date.now();

      await this._teardown();

      const bytes = fileSize(this.livePath);
      log.info("capture ended", { recorderId: this.id, bytes, sides: this.sides.length });

      this.job = renderQueue.enqueue(this._buildJob());
      this.status = this.job.status;
      return this.snapshot();
    })();
    return this._captureStopPromise;
  }

  /** Kept for callers that read as "stop the recording". */
  async stop() {
    return this.stopCapture();
  }

  snapshot() {
    return {
      id: this.id,
      active: this.active,
      status: this.status,
      roomId: this.room.id,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      job: this.job || null,
    };
  }
}

module.exports = { CloudRecorder, RECORDINGS_DIR };
