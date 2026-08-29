const config = require("../config/mediasoup");
const { createRouter } = require("./workerManager");
const { CloudRecorder } = require("../recording/cloudRecorder");
const attendance = require("../attendance/attendanceLog");
const { createLogger } = require("../utils/logger");

const log = createLogger("RoomManager");

const TEACHER_GRACE_MS = Number(process.env.TEACHER_RECONNECT_GRACE_MS || 120000);

/**
 * Who is speaking, judged from the audio itself rather than from whether a
 * microphone happens to be unmuted.
 *
 * -55 dBov is quiet speech; below it is room noise, a fan, or breathing, and
 * showing those as "talking" would leave the indicator on permanently. The
 * interval is how often the room is re-judged: often enough to feel live,
 * rarely enough that a full class is not a broadcast storm.
 */
const SPEAKING_THRESHOLD_DB = Number(process.env.SPEAKING_THRESHOLD_DB || -55);
const SPEAKING_INTERVAL_MS = Number(process.env.SPEAKING_INTERVAL_MS || 400);
const SPEAKING_MAX = Number(process.env.SPEAKING_MAX || 6);

// Set by the socket layer, which owns the only way to reach the browsers.
let speakingListener = () => {};
function onSpeaking(fn) {
  speakingListener = fn;
}

const ROLES = new Set(["teacher", "student", "coordinator"]);

function normalizeRole(role) {
  const r = String(role || "student").toLowerCase();
  if (r === "co-ordinator" || r === "co_ordinator" || r === "admin") return "coordinator";
  return ROLES.has(r) ? r : "student";
}

class Peer {
  constructor({ id, socketId, name, role }) {
    this.id = id;
    this.socketId = socketId;
    this.name = name;
    this.role = normalizeRole(role);
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.audioMuted = false;
    this.videoOff = this.role !== "teacher";
    this.disconnected = false;
    this.handRaised = false;
    // Ordering key so staff can answer hands in the order they went up.
    this.handRaisedAt = null;
    this.joinedAt = Date.now();
  }

  public() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      audioMuted: this.audioMuted,
      videoOff: this.videoOff,
      disconnected: this.disconnected,
      handRaised: this.handRaised,
      handRaisedAt: this.handRaisedAt,
    };
  }
}

class Room {
  constructor(id, router) {
    this.id = id;
    this.router = router;
    this.peers = new Map();
    this.createdAt = Date.now();
    this.closed = false;
    this.recorder = null;
    this.audioObserver = null;
    this.teacherLeaveTimer = null;
    // Questions put to the class by staff. Each carries its own answers, which
    // only staff are ever sent — see questionPublic in the socket layer.
    this.questions = [];
    this.whiteboard = [];
    this.polls = [];
    this.stageMode = "whiteboard";
  }

  hasLiveStaff() {
    return this.getStaff().some((p) => !p.disconnected);
  }

  getTeacher() {
    return [...this.peers.values()].find((p) => p.role === "teacher") || null;
  }

  getStaff() {
    return [...this.peers.values()].filter((p) => p.role === "teacher" || p.role === "coordinator");
  }

  participants() {
    return [...this.peers.values()].map((p) => p.public());
  }

  findProducer(peerId, source) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    for (const producer of peer.producers.values()) {
      if (producer.appData && producer.appData.source === source) return producer;
    }
    return null;
  }

  listProducers() {
    const list = [];
    for (const peer of this.peers.values()) {
      for (const producer of peer.producers.values()) {
        list.push({
          producerId: producer.id,
          peerId: peer.id,
          kind: producer.kind,
          source: producer.appData.source,
          role: peer.role,
        });
      }
    }
    return list;
  }

  /**
   * One audio level observer per room, created with the first microphone.
   *
   * mediasoup measures the level of every audio producer it is watching and
   * reports the loudest, which is the only way to know who is *talking* rather
   * than merely unmuted. A paused producer sends nothing, so muted people never
   * appear here.
   */
  async _ensureAudioObserver() {
    if (this.audioObserver) return this.audioObserver;
    try {
      this.audioObserver = await this.router.createAudioLevelObserver({
        maxEntries: SPEAKING_MAX,
        threshold: SPEAKING_THRESHOLD_DB,
        interval: SPEAKING_INTERVAL_MS,
      });

      // Loudest first, which is the order the participant list wants.
      this.audioObserver.on("volumes", (volumes) => {
        try {
          const speakers = volumes
            .map((entry) => entry.producer?.appData?.peerId)
            .filter((id) => id && this.peers.has(id));
          speakingListener(this.id, speakers);
        } catch (err) {
          log.error("volumes handler failed", err);
        }
      });

      this.audioObserver.on("silence", () => {
        try {
          speakingListener(this.id, []);
        } catch (err) {
          log.error("silence handler failed", err);
        }
      });

      log.info("audio level observer created", {
        roomId: this.id,
        thresholdDb: SPEAKING_THRESHOLD_DB,
        intervalMs: SPEAKING_INTERVAL_MS,
      });
    } catch (err) {
      // Speaker indicators are a nicety; a room without them still works.
      log.error("could not create the audio level observer", err);
      this.audioObserver = null;
    }
    return this.audioObserver;
  }

  /** Watches one microphone. The observer drops it by itself when it closes. */
  async _watchAudio(producer) {
    try {
      const observer = await this._ensureAudioObserver();
      if (!observer) return;
      await observer.addProducer({ producerId: producer.id });
    } catch (err) {
      log.error("could not watch this microphone for speaking", err);
    }
  }

  async createWebRtcTransport(peer) {
    try {
      log.action("createWebRtcTransport", { roomId: this.id, peerId: peer.id });
      const transport = await this.router.createWebRtcTransport(config.webRtcTransport);
      peer.transports.set(transport.id, transport);

      transport.on("dtlsstatechange", (state) => {
        log.info("dtlsstatechange", { transportId: transport.id, state, peerId: peer.id });
        if (state === "closed" || state === "failed") {
          transport.close();
        }
      });

      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    } catch (err) {
      log.error("createWebRtcTransport failed", err);
      throw err;
    }
  }

  async connectTransport(peer, transportId, dtlsParameters) {
    try {
      log.action("connectTransport", { peerId: peer.id, transportId });
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error("Transport not found");
      await transport.connect({ dtlsParameters });
    } catch (err) {
      log.error("connectTransport failed", err);
      throw err;
    }
  }

  async produce(peer, { transportId, kind, rtpParameters, source }) {
    try {
      // Coordinator = admin: can share screen, cannot publish camera (teacher camera only)
      if (peer.role === "coordinator" && source === "video") {
        throw new Error("Coordinator has no camera (use screen share instead)");
      }
      if (peer.role === "student" && (source === "video" || source === "screen")) {
        throw new Error("Students cannot produce video or screen share");
      }
      // An unrecognised source would be published under a name nothing looks
      // for: never consumed, never recorded, and -- because replacement is by
      // source -- capable of closing the wrong producer on its way in.
      if (!["audio", "video", "screen"].includes(source)) {
        throw new Error(`Unknown producer source "${source}"`);
      }
      log.action("produce", { peerId: peer.id, kind, source, role: peer.role });
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error("Transport not found");

      // A teacher who reconnects publishes a fresh camera and mic while the old
      // producers are still held open by the grace period. Leaving both in place
      // meant findProducer kept returning the dead one, so the recorder and any
      // late joiner subscribed to a track that would never send another packet.
      const stale = this.findProducer(peer.id, source);
      if (stale) {
        // Loud, because closing a producer is destructive and this is the only
        // place it happens implicitly. If a camera is ever closed by a screen
        // share arriving, this line is where it will be visible.
        log.warn("closing an existing producer to replace it", {
          peerId: peer.id,
          name: peer.name,
          source,
          staleId: stale.id,
          staleKind: stale.kind,
          newKind: kind,
        });
        try {
          stale.close();
        } catch (err) {
          log.error("close stale producer failed", err);
        }
        peer.producers.delete(stale.id);
      }

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { source, peerId: peer.id, role: peer.role, replaces: stale?.id || null },
      });
      peer.producers.set(producer.id, producer);

      // An active recording is bound to the producers it started with, so it
      // needs telling about anything new.
      if (this.recorder && this.recorder.active) {
        this.recorder.onProducerAdded(peer, producer).catch((err) => {
          log.error("recorder update failed", err);
        });
      }

      if (source === "video") peer.videoOff = false;
      if (source === "audio") {
        peer.audioMuted = false;
        await this._watchAudio(producer);
      }

      producer.on("transportclose", () => {
        log.info("producer transportclose", { producerId: producer.id });
        peer.producers.delete(producer.id);
      });

      return producer;
    } catch (err) {
      log.error("produce failed", err);
      throw err;
    }
  }

  async consume(peer, { producerId, rtpCapabilities, transportId }) {
    try {
      log.action("consume", { peerId: peer.id, producerId });
      if (!this.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error("Cannot consume this producer");
      }
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error("Recv transport not found");

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);

      consumer.on("transportclose", () => peer.consumers.delete(consumer.id));
      consumer.on("producerclose", () => peer.consumers.delete(consumer.id));

      return {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
        appData: consumer.appData,
      };
    } catch (err) {
      log.error("consume failed", err);
      throw err;
    }
  }

  async resumeConsumer(peer, consumerId) {
    try {
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) throw new Error("Consumer not found");
      await consumer.resume();
      log.info("consumer resumed", { consumerId, peerId: peer.id });
    } catch (err) {
      log.error("resumeConsumer failed", err);
      throw err;
    }
  }

  async pauseProducer(peer, source) {
    try {
      const producer = this.findProducer(peer.id, source);
      if (!producer) return;
      await producer.pause();
      if (source === "audio") peer.audioMuted = true;
      if (source === "video") peer.videoOff = true;
      log.action("pauseProducer", { peerId: peer.id, source });
    } catch (err) {
      log.error("pauseProducer failed", err);
      throw err;
    }
  }

  async resumeProducer(peer, source) {
    try {
      if (peer.role !== "teacher" && source === "video") {
        throw new Error("Only the teacher can enable camera");
      }
      const producer = this.findProducer(peer.id, source);
      if (!producer) return;
      await producer.resume();
      if (source === "audio") peer.audioMuted = false;
      if (source === "video") peer.videoOff = false;
      log.action("resumeProducer", { peerId: peer.id, source });

      // Someone unmuting during a recording needs their own capture: the class
      // used to have the teacher answering questions nobody could hear.
      if (source === "audio" && this.recorder && this.recorder.active) {
        this.recorder.addVoice(peer).catch((err) => log.error("recorder addVoice failed", err));
      }
    } catch (err) {
      log.error("resumeProducer failed", err);
      throw err;
    }
  }

  async closeProducer(peer, source) {
    try {
      const producer = this.findProducer(peer.id, source);
      if (!producer) return;
      producer.close();
      peer.producers.delete(producer.id);
      if (source === "video" || source === "screen") peer.videoOff = source === "video" ? true : peer.videoOff;
      log.action("closeProducer", { peerId: peer.id, source });
    } catch (err) {
      log.error("closeProducer failed", err);
      throw err;
    }
  }

  async startRecording() {
    try {
      if (this.recorder && this.recorder.active) {
        return this.recorder.snapshot();
      }
      this.recorder = new CloudRecorder(this);
      return await this.recorder.start();
    } catch (err) {
      log.error("startRecording failed", err);
      throw err;
    }
  }

  /**
   * Ends the capture and returns as soon as it is safely on disk. Rendering is
   * queued and happens in the background, so nothing here waits on ffmpeg.
   */
  async stopRecording() {
    try {
      if (!this.recorder) return null;
      return await this.recorder.stopCapture();
    } catch (err) {
      log.error("stopRecording failed", err);
      throw err;
    }
  }

  closePeerMedia(peer) {
    try {
      for (const consumer of peer.consumers.values()) {
        try {
          consumer.close();
        } catch (err) {
          log.error("close consumer", err);
        }
      }
      for (const producer of peer.producers.values()) {
        try {
          producer.close();
        } catch (err) {
          log.error("close producer", err);
        }
      }
      for (const transport of peer.transports.values()) {
        try {
          transport.close();
        } catch (err) {
          log.error("close transport", err);
        }
      }
      peer.consumers.clear();
      peer.producers.clear();
      peer.transports.clear();
    } catch (err) {
      log.error("closePeerMedia failed", err);
    }
  }
}

const rooms = new Map();

async function getOrCreateRoom(roomId) {
  try {
    let room = rooms.get(roomId);
    if (room && !room.closed) return room;
    const router = await createRouter();
    room = new Room(roomId, router);
    rooms.set(roomId, room);
    log.info("room created", { roomId });
    return room;
  } catch (err) {
    log.error("getOrCreateRoom failed", err);
    throw err;
  }
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function removePeerFromRoom(room, peer, { force = false } = {}) {
  try {
    log.action("removePeer", { roomId: room.id, peerId: peer.id, role: peer.role, force });

    if (peer.role === "teacher" && !force) {
      peer.disconnected = true;
      if (room.teacherLeaveTimer) clearTimeout(room.teacherLeaveTimer);
      room.teacherLeaveTimer = setTimeout(() => {
        try {
          const current = room.peers.get(peer.id);
          if (current && current.disconnected) {
            log.warn("teacher grace expired — removing teacher, room stays", { peerId: peer.id });
            room.closePeerMedia(current);
            room.peers.delete(peer.id);
          }
        } catch (err) {
          log.error("teacher grace cleanup failed", err);
        }
      }, TEACHER_GRACE_MS);
      log.info("teacher marked disconnected; room stays alive", {
        roomId: room.id,
        graceMs: TEACHER_GRACE_MS,
        recording: Boolean(room.recorder && room.recorder.active),
      });
      return { keptAlive: true };
    }

    room.closePeerMedia(peer);
    room.peers.delete(peer.id);
    return { keptAlive: false };
  } catch (err) {
    log.error("removePeerFromRoom failed", err);
    throw err;
  }
}

async function closeRoom(room) {
  try {
    log.action("closeRoom", { roomId: room.id });
    room.closed = true;
    if (room.teacherLeaveTimer) clearTimeout(room.teacherLeaveTimer);
    for (const poll of room.polls) {
      if (poll.timer) clearTimeout(poll.timer);
      poll.timer = null;
    }
    // Stop the capture before the router goes. The render is already queued and
    // runs on its own, so closing a session never waits on ffmpeg.
    if (room.recorder && room.recorder.active) {
      await room.stopRecording();
    }
    // Anyone still in the room when it closes needs their session ended, or
    // they would read as permanently present. A peer already marked
    // disconnected logged its leave on disconnect, so it is skipped here.
    for (const peer of room.peers.values()) {
      if (!peer.disconnected) attendance.recordLeave(room.id, peer, "session-closed");
    }
    for (const peer of room.peers.values()) {
      room.closePeerMedia(peer);
    }
    room.peers.clear();
    try {
      room.router.close();
    } catch (err) {
      log.error("router close failed", err);
    }
    rooms.delete(room.id);
  } catch (err) {
    log.error("closeRoom failed", err);
    throw err;
  }
}

module.exports = {
  Peer,
  Room,
  rooms,
  getOrCreateRoom,
  getRoom,
  removePeerFromRoom,
  closeRoom,
  onSpeaking,
  TEACHER_GRACE_MS,
  normalizeRole,
};
