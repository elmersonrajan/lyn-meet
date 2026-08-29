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
const attendance = require("../attendance/attendanceLog");
const renderQueue = require("../recording/renderQueue");

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

/**
 * A coordinator is an office role, not a person: the name is fixed so the
 * participant list, attendance and announcements all read the same regardless
 * of who is covering. Enforced here, not just hidden in the lobby.
 */
const COORDINATOR_NAME = "ADMIN";

function displayNameFor(role, typedName) {
  return role === "coordinator" ? COORDINATOR_NAME : typedName;
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

const POLL_DURATION_MS = Number(process.env.POLL_DURATION_MS || 120000);

/** Vote counts and the correct answer stay hidden until the poll closes. */
function pollPublic(poll, peerId) {
  const view = {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    from: poll.from,
    createdAt: poll.createdAt,
    endsAt: poll.endsAt,
    closed: poll.closed,
    totalVotes: poll.votes.size,
  };
  if (poll.closed) {
    const counts = poll.options.map(() => 0);
    for (const idx of poll.votes.values()) {
      if (counts[idx] != null) counts[idx] += 1;
    }
    view.counts = counts;
    view.correctIndex = poll.correctIndex;
  }
  if (peerId && poll.votes.has(peerId)) {
    view.myVote = poll.votes.get(peerId);
  }
  return view;
}

function closePoll(io, room, poll) {
  try {
    if (poll.closed) return;
    poll.closed = true;
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
    log.action("poll-ended", { roomId: room.id, pollId: poll.id, votes: poll.votes.size });
    io.to(room.id).emit("poll-ended", pollPublic(poll));
  } catch (err) {
    log.error("closePoll failed", err);
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
    polls: room.polls.map((p) => pollPublic(p, peer.id)),
    whiteboard: room.whiteboard,
    recording: room.recorder ? room.recorder.snapshot() : null,
    // Anything for this meeting still being built, so somebody joining or
    // reloading sees where it got to rather than nothing at all.
    recordingJobs: renderQueue.listJobs().filter((j) => j.meetingId === room.id),
    producers: room.listProducers(),
    ...extra,
  };
}

function attachSocketHandlers(io) {
  // Render progress reaches whoever is still in the room. Best effort on
  // purpose: a class usually ends before its recording has finished building,
  // and the render neither knows nor cares whether anyone is listening.
  renderQueue.onStatus((status) => {
    try {
      io.to(status.meetingId).emit("recording-status", status);
    } catch (err) {
      log.error("recording status broadcast failed", err);
    }
  });

  io.on("connection", (socket) => {
    log.info("client connected", { socketId: socket.id });
    socket.data.peerId = null;
    socket.data.roomId = null;

    socket.on("join-room", async (payload, callback) => {
      try {
        const typedName = String(payload?.name || "").trim();
        const meetingId = String(payload?.meetingId || "").trim();
        const role = normalizeRole(payload?.role);
        log.action("join-room", { typedName, meetingId, role, socketId: socket.id });

        if (!typedName || !meetingId) {
          throw new Error("Name and meeting ID are required");
        }
        const name = displayNameFor(role, typedName);

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
            io.to(room.id).emit("participants", room.participants());
            meetingLog.writeEntry("teacher-reconnect", {
              name,
              meetingId,
              peerId: currentTeacher.id,
            });
            attendance.recordJoin(room.id, currentTeacher, "reconnect");
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
        attendance.recordJoin(room.id, peer, "join");

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
        // Only the teacher arrives live. Students and coordinators join muted
        // and unmute deliberately. Paused here, before the participants
        // broadcast below, so nobody is ever listed as unmuted by mistake.
        if (producer.appData.source === "audio" && peer.role !== "teacher") {
          await room.pauseProducer(peer, "audio");
          const locked = peer.role === "student" && !room.hasLiveStaff();
          socket.emit("joined-muted", {
            locked,
            reason: locked
              ? "You joined muted — you can unmute once a teacher or coordinator is here"
              : "You joined muted — unmute when you want to speak",
          });
        }
        // Told before the replacement, so nobody is briefly subscribed to two
        // producers for one source and left rendering the dead one.
        if (producer.appData.replaces) {
          socket.to(room.id).emit("producer-closed", {
            producerId: producer.appData.replaces,
            peerId: peer.id,
            source: producer.appData.source,
          });
        }
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
        if (peer.role === "student" && source === "audio" && !room.hasLiveStaff()) {
          throw new Error("You can unmute only while a teacher or coordinator is in the meeting");
        }
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
        attendance.recordLeave(room.id, target, "removed");
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
        requireStaff(peer);
        const rec = await room.startRecording();
        io.to(room.id).emit("recording-started", rec);
        ack(callback, { ok: true, recording: rec });
      } catch (err) {
        log.error("start-recording failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    /**
     * Stopping answers as soon as the capture is safely on disk.
     *
     * The render is queued and runs in the background; progress arrives later as
     * `recording-status` for anyone still here, and is readable at any time from
     * /api/recordings/status. Nothing about it holds the teacher up -- they can
     * close the tab the moment this returns.
     */
    socket.on("stop-recording", async (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        requireStaff(peer);
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
        requireStaff(peer);
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
        // Teacher only — hiding the palette is not enough on its own.
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
        // Clearing is drawing — same restriction as strokes.
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
        requireStaff(peer);
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

    socket.on("raise-hand", ({ raised }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");

        const next = Boolean(raised);
        peer.handRaised = next;
        peer.handRaisedAt = next ? Date.now() : null;
        log.action("raise-hand", { roomId: room.id, peerId: peer.id, raised: next });

        // Staff need the name to act on it; everyone needs the list refreshed.
        io.to(room.id).emit("hand-changed", {
          peerId: peer.id,
          name: peer.name,
          role: peer.role,
          raised: next,
          at: peer.handRaisedAt,
        });
        io.to(room.id).emit("participants", room.participants());
        ack(callback, { ok: true, raised: next });
      } catch (err) {
        log.error("raise-hand failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("lower-hand", ({ peerId }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        // Lowering your own hand is always allowed; anyone else's is staff-only.
        if (peerId && peerId !== peer.id) requireStaff(peer);

        const target = room.peers.get(peerId || peer.id);
        if (!target) throw new Error("Participant not found");
        target.handRaised = false;
        target.handRaisedAt = null;
        log.action("lower-hand", { roomId: room.id, target: target.id, by: peer.id });

        io.to(room.id).emit("hand-changed", {
          peerId: target.id,
          name: target.name,
          role: target.role,
          raised: false,
          loweredBy: target.id === peer.id ? null : peer.name,
        });
        io.to(room.id).emit("participants", room.participants());
        ack(callback, { ok: true });
      } catch (err) {
        log.error("lower-hand failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("lower-all-hands", (_payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        requireStaff(peer);

        let cleared = 0;
        for (const other of room.peers.values()) {
          if (other.handRaised) {
            other.handRaised = false;
            other.handRaisedAt = null;
            cleared += 1;
          }
        }
        log.action("lower-all-hands", { roomId: room.id, by: peer.id, cleared });
        io.to(room.id).emit("hands-cleared", { by: peer.name, cleared });
        io.to(room.id).emit("participants", room.participants());
        ack(callback, { ok: true, cleared });
      } catch (err) {
        log.error("lower-all-hands failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("create-poll", (payload, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        requireStaff(peer);

        const question = String(payload?.question || "").trim().slice(0, 500);
        if (!question) throw new Error("Poll question is required");

        const options = (Array.isArray(payload?.options) ? payload.options : [])
          .slice(0, 4)
          .map((o) => String(o || "").trim().slice(0, 200));
        if (options.length !== 4 || options.some((o) => !o)) {
          throw new Error("Provide all 4 options");
        }

        const correctIndex = Number(payload?.correctIndex);
        if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
          throw new Error("Mark which option is correct");
        }

        if (room.polls.some((p) => !p.closed)) {
          throw new Error("A poll is already running — wait for it to finish");
        }

        const durationMs = Math.min(
          Math.max(Number(payload?.durationMs) || POLL_DURATION_MS, 15000),
          600000,
        );
        const now = Date.now();
        const poll = {
          id: uuid(),
          question,
          options,
          correctIndex,
          from: peer.name,
          createdAt: now,
          endsAt: now + durationMs,
          closed: false,
          votes: new Map(),
          timer: null,
        };
        room.polls.push(poll);
        if (room.polls.length > 50) room.polls.splice(0, room.polls.length - 50);
        poll.timer = setTimeout(() => closePoll(io, room, poll), durationMs);

        log.action("poll-started", { roomId: room.id, pollId: poll.id, by: peer.name, durationMs });
        io.to(room.id).emit("poll-started", pollPublic(poll));
        ack(callback, { ok: true, poll: pollPublic(poll, peer.id) });
      } catch (err) {
        log.error("create-poll failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("vote-poll", ({ pollId, optionIndex }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");

        const poll = room.polls.find((p) => p.id === pollId);
        if (!poll) throw new Error("Poll not found");
        if (poll.closed || Date.now() >= poll.endsAt) throw new Error("This poll has closed");
        if (poll.votes.has(peer.id)) throw new Error("You already voted");

        const idx = Number(optionIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) {
          throw new Error("Invalid option");
        }

        poll.votes.set(peer.id, idx);
        log.action("poll-vote", { roomId: room.id, pollId: poll.id, peerId: peer.id });
        io.to(room.id).emit("poll-vote-count", { pollId: poll.id, totalVotes: poll.votes.size });
        ack(callback, { ok: true, optionIndex: idx });
      } catch (err) {
        log.error("vote-poll failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    socket.on("end-poll", ({ pollId }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        requireStaff(peer);
        const poll = room.polls.find((p) => p.id === pollId);
        if (!poll) throw new Error("Poll not found");
        closePoll(io, room, poll);
        ack(callback, { ok: true });
      } catch (err) {
        log.error("end-poll failed", err);
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
        await handleDisconnect(io, socket, { voluntary: true });
        callback?.({ ok: true });
      } catch (err) {
        log.error("leave-room failed", err);
        callback?.({ ok: false, error: err.message });
      }
    });

    socket.on("disconnect", async (reason) => {
      try {
        log.info("client disconnected", { socketId: socket.id, reason });
        await handleDisconnect(io, socket, { voluntary: false });
      } catch (err) {
        log.error("disconnect handler failed", err);
      }
    });
  });
}

/** With no staff left, students lose the mic until a teacher or coordinator returns. */
async function lockStudentMicsIfUnstaffed(io, room) {
  try {
    if (room.hasLiveStaff()) return;
    for (const student of room.peers.values()) {
      if (student.role === "student") await room.pauseProducer(student, "audio");
    }
    io.to(room.id).emit("mic-locked", {
      reason: "Mic disabled — no teacher or coordinator in the meeting",
    });
    io.to(room.id).emit("participants", room.participants());
  } catch (err) {
    log.error("lockStudentMicsIfUnstaffed failed", err);
  }
}

async function handleDisconnect(io, socket, { voluntary }) {
  try {
    const room = getRoom(socket.data.roomId);
    const peer = room?.peers.get(socket.data.peerId);
    if (!room || !peer) return;

    const wasStaff = peer.role === "teacher" || peer.role === "coordinator";
    const force = voluntary || peer.role !== "teacher";
    // Recorded before removal, while peer.name/role are still readable. A
    // teacher inside the grace window counts as gone -- reconnecting opens a
    // new session, so the gap is visible rather than billed as attendance.
    attendance.recordLeave(room.id, peer, voluntary ? "left" : "disconnected");
    // A teacher inside the grace window keeps their Peer, so a raised hand
    // would otherwise stay up while they are not even connected.
    peer.handRaised = false;
    peer.handRaisedAt = null;
    const result = removePeerFromRoom(room, peer, { force });

    if (peer.role === "teacher" && result.keptAlive && !voluntary) {
      socket.to(room.id).emit("teacher-disconnected", {
        peerId: peer.id,
        message: "Teacher lost connection. Meeting continues.",
      });
      socket.to(room.id).emit("participants", room.participants());
      await lockStudentMicsIfUnstaffed(io, room);
      return;
    }

    if (wasStaff) await lockStudentMicsIfUnstaffed(io, room);

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
