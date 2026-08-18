const config = require("../config/mediasoup");
const { createRouter } = require("./workerManager");
const { CloudRecorder } = require("../recording/cloudRecorder");
const { createLogger } = require("../utils/logger");

const log = createLogger("RoomManager");

const TEACHER_GRACE_MS = Number(process.env.TEACHER_RECONNECT_GRACE_MS || 120000);

class Peer {
  constructor({ id, socketId, name, role }) {
    this.id = id;
    this.socketId = socketId;
    this.name = name;
    this.role = role;
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.audioMuted = false;
    this.videoOff = role !== "teacher";
    this.disconnected = false;
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
    this.teacherLeaveTimer = null;
    this.chat = [];
    this.whiteboard = [];
    this.stageMode = "whiteboard";
  }

  getTeacher() {
    return [...this.peers.values()].find((p) => p.role === "teacher") || null;
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
      if (peer.role !== "teacher" && (source === "video" || source === "screen")) {
        throw new Error("Students cannot produce video or screen share");
      }
      log.action("produce", { peerId: peer.id, kind, source });
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error("Transport not found");

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { source, peerId: peer.id, role: peer.role },
      });
      peer.producers.set(producer.id, producer);

      if (source === "video") peer.videoOff = false;
      if (source === "audio") peer.audioMuted = false;

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
        throw new Error("Students cannot enable camera");
      }
      const producer = this.findProducer(peer.id, source);
      if (!producer) return;
      await producer.resume();
      if (source === "audio") peer.audioMuted = false;
      if (source === "video") peer.videoOff = false;
      log.action("resumeProducer", { peerId: peer.id, source });
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

  async stopRecording() {
    try {
      if (!this.recorder) return null;
      const snap = await this.recorder.stop();
      return snap;
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
            log.warn("teacher grace expired — closing teacher media", { peerId: peer.id });
            room.closePeerMedia(current);
            room.peers.delete(peer.id);
          }
        } catch (err) {
          log.error("teacher grace cleanup failed", err);
        }
      }, TEACHER_GRACE_MS);
      log.info("teacher marked disconnected; room + recording stay alive", {
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
    if (room.recorder && room.recorder.active) {
      await room.stopRecording();
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
  TEACHER_GRACE_MS,
};
