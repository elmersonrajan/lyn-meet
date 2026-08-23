const { randomUUID } = require("crypto");
const { getIceServers } = require("../config/ice");
const {
  Peer,
  getOrCreateRoom,
  getRoom,
  removePeerFromRoom,
  closeRoom,
  normalizeRole,
} = require("../mediasoup/roomManager");
const { createLogger } = require("../utils/logger");
const meetingLog = require("../utils/meetingLog");

const log = createLogger("Socket");

function ack(callback, payload) {
  try {
    if (typeof callback === "function") callback(payload);
  } catch (err) {
    log.error("ack failed", err);
  }
}

function uuid() {
  try {
    return randomUUID();
  } catch (err) {
    log.error("uuid failed", err);
    return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function requireTeacher(peer) {
  if (!peer || peer.role !== "teacher") {
    throw new Error("Only the teacher can perform this action");
  }
}

function requireStaff(peer) {
  if (!peer || (peer.role !== "teacher" && peer.role !== "coordinator")) {
    throw new Error("Only the teacher or coordinator can perform this action");
  }
}

function joinAck(room, peer, extra = {}) {
  return {
    ok: true,
    peer: peer.public(),
    participants: room.participants(),
    routerRtpCapabilities: room.router.rtpCapabilities,
    iceServers: getIceServers(),
    stageMode: room.stageMode,
    chat: room.chat,
    whiteboard: room.whiteboard,
    recording: room.recorder ? room.recorder.snapshot() : null,
    producers: room.listProducers(),
    ...extra,
  };
}

function attachSocketHandlers(io) {
  io.on("connection", (socket) => {
    log.info("client connected", { socketId: socket.id });
    socket.data.peerId = null;
    socket.data.roomId = null;

    socket.on("join-room", async (payload, callback) => {
      try {
        const name = String(payload?.name || "").trim();
        const meetingId = String(payload?.meetingId || "").trim();
        const role = normalizeRole(payload?.role);
        log.action("join-room", { name, meetingId, role, socketId: socket.id });

        if (!name || !meetingId) {
          throw new Error("Name and meeting ID are required");
        }

        const room = await getOrCreateRoom(meetingId);

        if (role === "teacher") {
          const currentTeacher = room.getTeacher();
          if (currentTeacher && !currentTeacher.disconnected) {
            throw new Error("This meeting already has an active teacher");
          }
          if (currentTeacher && currentTeacher.disconnected) {
            log.info("teacher reconnecting into existing peer", {
              peerId: currentTeacher.id,
              meetingId,
            });
            currentTeacher.socketId = socket.id;
            currentTeacher.disconnected = false;
            currentTeacher.name = name;
            if (room.teacherLeaveTimer) {
              clearTimeout(room.teacherLeaveTimer);
              room.teacherLeaveTimer = null;
            }
            socket.data.peerId = currentTeacher.id;
            socket.data.roomId = room.id;
            socket.join(room.id);
            socket.to(room.id).emit("peer-reconnected", currentTeacher.public());
            meetingLog.writeEntry("teacher-reconnect", {
              name,
              meetingId,
              peerId: currentTeacher.id,
            });
            ack(callback, joinAck(room, currentTeacher, { reconnected: true }));
            return;
          }
        }

        const peer = new Peer({
          id: uuid(),
          socketId: socket.id,
          name,
          role,
        });
        room.peers.set(peer.id, peer);
        socket.data.peerId = peer.id;
        socket.data.roomId = room.id;
        socket.join(room.id);

        socket.to(room.id).emit("peer-joined", peer.public());

        if (role === "teacher") {
          meetingLog.reset({ meetingId, teacher: name, peerId: peer.id });
        } else {
          meetingLog.writeEntry("join-room", { name, role, meetingId, peerId: peer.id });
        }

        ack(callback, joinAck(room, peer, { reconnected: false }));
      } catch (err) {
        log.error("join-room failed", err);
        meetingLog.writeEntry("join-room-failed", { error: err.message });
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("create-transport", async ({ direction }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        log.action("create-transport", { direction, peerId: peer.id });
        const params = await room.createWebRtcTransport(peer);
        ack(callback, { ok: true, params, direction });
      } catch (err) {
        log.error("create-transport failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("connect-transport", async ({ transportId, dtlsParameters }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        await room.connectTransport(peer, transportId, dtlsParameters);
        ack(callback, { ok: true });
      } catch (err) {
        log.error("connect-transport failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("produce", async ({ transportId, kind, rtpParameters, source }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        const producer = await room.produce(peer, {
          transportId,
          kind,
          rtpParameters,
          source: source || kind,
        });
        socket.to(room.id).emit("new-producer", {
          producerId: producer.id,
          peerId: peer.id,
          kind: producer.kind,
          source: producer.appData.source,
          role: peer.role,
        });
        io.to(room.id).emit("participants", room.participants());
        ack(callback, { ok: true, id: producer.id });
      } catch (err) {
        log.error("produce failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        const params = await room.consume(peer, {
          producerId,
          rtpCapabilities,
          transportId,
        });
        ack(callback, { ok: true, params });
      } catch (err) {
        log.error("consume failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("resume-consumer", async ({ consumerId }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        await room.resumeConsumer(peer, consumerId);
        ack(callback, { ok: true });
      } catch (err) {
        log.error("resume-consumer failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("get-producers", (payload, callback) => {
      try {
        if (typeof payload === "function") {
          callback = payload;
        }
        const room = getRoom(socket.data.roomId);
        if (!room) throw new Error("Not in a room");
        ack(callback, { ok: true, producers: room.listProducers() });
      } catch (err) {
        log.error("get-producers failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("client-log", (payload) => {
      try {
        meetingLog.writeEntry("CLIENT", payload);
      } catch (err) {
        log.error("client-log failed", err);
      }
    });

    socket.on("pause-producer", async ({ source }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        await room.pauseProducer(peer, source);
        io.to(room.id).emit("participants", room.participants());
        io.to(room.id).emit("media-state", { peerId: peer.id, source, paused: true });
        ack(callback, { ok: true });
      } catch (err) {
        log.error("pause-producer failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("resume-producer", async ({ source }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        await room.resumeProducer(peer, source);
        io.to(room.id).emit("participants", room.participants());
        io.to(room.id).emit("media-state", { peerId: peer.id, source, paused: false });
        ack(callback, { ok: true });
      } catch (err) {
        log.error("resume-producer failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("close-producer", async ({ source }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        const producer = room.findProducer(peer.id, source);
        const producerId = producer?.id;
        await room.closeProducer(peer, source);
        socket.to(room.id).emit("producer-closed", { producerId, peerId: peer.id, source });
        io.to(room.id).emit("participants", room.participants());
        ack(callback, { ok: true });
      } catch (err) {
        log.error("close-producer failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("mute-others", async (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireStaff(peer);
        log.action("mute-others", { roomId: room.id, by: peer.id, role: peer.role });
        for (const other of room.peers.values()) {
          if (other.id !== peer.id && other.role === "student") {
            await room.pauseProducer(other, "audio");
          }
        }
        io.to(room.id).emit("force-mute");
        io.to(room.id).emit("participants", room.participants());
        ack(callback, { ok: true });
      } catch (err) {
        log.error("mute-others failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("remove-participant", async ({ peerId }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireStaff(peer);
        const target = room.peers.get(peerId);
        if (!target) throw new Error("Participant not found");
        if (target.id === peer.id) throw new Error("Cannot remove yourself");
        if (target.role === "teacher" && peer.role !== "coordinator") {
          throw new Error("Only a coordinator can remove the teacher");
        }
        log.action("remove-participant", {
          roomId: room.id,
          by: peer.id,
          target: target.id,
          targetRole: target.role,
        });
        const sockets = await io.in(room.id).fetchSockets();
        const targetSock = sockets.find((s) => s.data.peerId === target.id);
        removePeerFromRoom(room, target, { force: true });
        io.to(room.id).emit("peer-removed", {
          peer: target.public(),
          by: peer.name,
        });
        io.to(room.id).emit("participants", room.participants());
        if (targetSock) {
          targetSock.emit("kicked", { reason: "Removed by " + peer.name });
          targetSock.leave(room.id);
          targetSock.data.peerId = null;
          targetSock.data.roomId = null;
        }
        ack(callback, { ok: true });
      } catch (err) {
        log.error("remove-participant failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("start-recording", async (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireTeacher(peer);
        const rec = await room.startRecording();
        io.to(room.id).emit("recording-started", rec);
        ack(callback, { ok: true, recording: rec });
      } catch (err) {
        log.error("start-recording failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("stop-recording", async (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireTeacher(peer);
        const rec = await room.stopRecording();
        io.to(room.id).emit("recording-stopped", rec);
        ack(callback, { ok: true, recording: rec });
      } catch (err) {
        log.error("stop-recording failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("set-stage", ({ mode }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireTeacher(peer);
        room.stageMode = mode;
        io.to(room.id).emit("stage-mode", { mode });
        ack(callback, { ok: true });
      } catch (err) {
        log.error("set-stage failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("whiteboard-stroke", (stroke, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireTeacher(peer);
        const cw = Number(stroke.canvasWidth) || 1280;
        const ch = Number(stroke.canvasHeight) || 720;
        const normalized = {
          color: stroke.color,
          width: stroke.width,
          canvasWidth: cw,
          canvasHeight: ch,
          at: Date.now(),
          points: (stroke.points || []).map((p) => ({
            x: p.x,
            y: p.y,
            nx: cw ? p.x / cw : 0,
            ny: ch ? p.y / ch : 0,
          })),
        };
        room.whiteboard.push(normalized);
        if (room.whiteboard.length > 4000) {
          room.whiteboard.splice(0, room.whiteboard.length - 4000);
        }
        socket.to(room.id).emit("whiteboard-stroke", stroke);
        callback?.({ ok: true });
      } catch (err) {
        log.error("whiteboard-stroke failed", err);
        callback?.({ ok: false, error: err.message });
      }
    });

    socket.on("whiteboard-clear", (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireTeacher(peer);
        room.whiteboard = [];
        io.to(room.id).emit("whiteboard-clear");
        ack(callback, { ok: true });
      } catch (err) {
        log.error("whiteboard-clear failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("post-message", ({ text, type }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        const message = {
          id: uuid(),
          text: String(text || "").slice(0, 2000),
          type: type === "qa" ? "qa" : "chat",
          from: peer.name,
          role: peer.role,
          at: Date.now(),
        };
        if (!message.text.trim()) throw new Error("Message is empty");
        room.chat.push(message);
        io.to(room.id).emit("chat-message", message);
        ack(callback, { ok: true, message });
      } catch (err) {
        log.error("post-message failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("close-session", async (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireStaff(peer);
        log.action("close-session", { roomId: room.id, by: peer.role });
        io.to(room.id).emit("session-closed", { reason: "Session closed by " + peer.role });
        await closeRoom(room);
        ack(callback, { ok: true });
      } catch (err) {
        log.error("close-session failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("leave-room", async (_payload, callback) => {
      try {
        await handleDisconnect(socket, { voluntary: true });
        callback?.({ ok: true });
      } catch (err) {
        log.error("leave-room failed", err);
        callback?.({ ok: false, error: err.message });
      }
    });

    socket.on("disconnect", async (reason) => {
      try {
        log.info("client disconnected", { socketId: socket.id, reason });
        await handleDisconnect(socket, { voluntary: false });
      } catch (err) {
        log.error("disconnect handler failed", err);
      }
    });
  });
}

async function handleDisconnect(socket, { voluntary }) {
  try {
    const room = getRoom(socket.data.roomId);
    const peer = room?.peers.get(socket.data.peerId);
    if (!room || !peer) return;

    const force = voluntary || peer.role !== "teacher";
    const result = removePeerFromRoom(room, peer, { force });

    if (peer.role === "teacher" && result.keptAlive && !voluntary) {
      socket.to(room.id).emit("teacher-disconnected", {
        peerId: peer.id,
        message: "Teacher lost connection. Meeting continues.",
      });
      socket.to(room.id).emit("participants", room.participants());
      return;
    }

    socket.to(room.id).emit("peer-left", peer.public());
    socket.to(room.id).emit("participants", room.participants());
    socket.leave(room.id);
    socket.data.peerId = null;
    socket.data.roomId = null;

    if (room.peers.size === 0) {
      log.info("room empty after leave — closing", { roomId: room.id });
      await closeRoom(room);
    }
  } catch (err) {
    log.error("handleDisconnect failed", err);
  }
}

module.exports = { attachSocketHandlers };
