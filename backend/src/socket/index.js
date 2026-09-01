const { randomUUID } = require("crypto");
const { getIceServers } = require("../config/ice");
const {
  Peer,
  getOrCreateRoom,
  getRoom,
  removePeerFromRoom,
  closeRoom,
  onSpeaking,
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

function isStaff(peer) {
  return Boolean(peer) && (peer.role === "teacher" || peer.role === "coordinator");
}

function requireStaff(peer) {
  if (!isStaff(peer)) {
    throw new Error("Only the teacher or coordinator can perform this action");
  }
}

/**
 * A second socket.io room holding only the teacher and coordinators.
 *
 * Answers to a question are marked for staff only, and the reliable way to keep
 * them that way is never to put them on the wire to anyone else. Filtering a
 * payload per recipient would work until the day someone adds a broadcast and
 * forgets; sending to a room students are not in cannot leak by omission.
 */
function staffRoom(roomId) {
  return `${roomId}::staff`;
}

const POLL_DURATION_MS = Number(process.env.POLL_DURATION_MS || 120000);

/**
 * What a question looks like to one person.
 *
 * Staff see every answer. A student sees the question, how many people have
 * answered, and their own answer — never anybody else's, which is the whole
 * point of asking this way rather than in the open.
 */
function questionPublic(question, peer) {
  const view = {
    id: question.id,
    text: question.text,
    from: question.from,
    role: question.role,
    at: question.at,
    closed: question.closed,
    answerCount: question.answers.size,
  };
  if (isStaff(peer)) {
    view.answers = [...question.answers.values()];
  } else if (peer && question.answers.has(peer.id)) {
    view.myAnswer = question.answers.get(peer.id);
  }
  return view;
}

/** Two sets of option indexes holding the same members. Both arrive sorted. */
function sameChoice(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Vote counts and the correct answers stay hidden until the poll closes. */
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
    // One person can now pick several options, so the counts add up to more
    // than the number of voters. totalVotes stays the count of people.
    const counts = poll.options.map(() => 0);
    for (const picks of poll.votes.values()) {
      for (const idx of picks) {
        if (counts[idx] != null) counts[idx] += 1;
      }
    }
    view.counts = counts;
    view.correct = poll.correct;
    // Credit only for the whole set: picking one of two right answers, or the
    // right one plus a wrong one, is not a correct answer to the question.
    view.correctVotes = [...poll.votes.values()].filter((picks) =>
      sameChoice(picks, poll.correct),
    ).length;
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
    questions: room.questions.map((q) => questionPublic(q, peer)),
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

  // Who is talking, several times a second. Deliberately not logged and not
  // acknowledged: it is a hint for the participant list, and a dropped one is
  // corrected by the next.
  onSpeaking((roomId, speakers) => {
    try {
      io.to(roomId).emit("active-speakers", { speakers });
    } catch (err) {
      log.error("active-speakers broadcast failed", err);
    }
  });

  io.on("connection", (socket) => {
    log.info("client connected", { socketId: socket.id });
    socket.data.peerId = null;
    socket.data.roomId = null;

    socket.on("join-room", async (payload, callback) => {
      try {
        // Identity comes from the handshake, never from this payload.
        //
        // The lobby used to send its own name and role, which meant anyone who
        // could open a socket could arrive as a teacher and take control of a
        // class. The socket middleware has already proved who this is against
        // the platform directory, so `payload.name` and `payload.role` are now
        // ignored outright rather than sanitised.
        const auth = socket.data.auth;
        if (!auth) throw new Error("Not signed in");

        const role = normalizeRole(auth.role);
        // Upper case is the rule, and this is where it is enforced: the room is
        // keyed by this string, so "neet26" and "NEET26" were two rooms, and
        // anyone who typed it in lower case sat alone in an empty meeting. The
        // browser upper-cases the field too, but a stale link or a direct call
        // has to land in the same place.
        const meetingId = String(payload?.meetingId || "").trim().toUpperCase();
        log.action("join-room", {
          email: auth.email,
          meetingId,
          role,
          socketId: socket.id,
        });

        if (!meetingId) {
          throw new Error("A meeting ID is required");
        }
        if (payload?.role && normalizeRole(payload.role) !== role) {
          // Not fatal -- the claim is simply discarded -- but worth a line in
          // the log, because a mismatch is either a stale client or a probe.
          log.warn("client-supplied role ignored", {
            email: auth.email,
            claimed: payload.role,
            actual: role,
          });
        }
        const name = displayNameFor(role, auth.name);

        const room = await getOrCreateRoom(meetingId);

        if (role === "teacher") {
          const currentTeacher = room.getTeacher();
          if (currentTeacher && !currentTeacher.disconnected) {
            throw new Error("This meeting already has an active teacher");
          }
          if (currentTeacher && currentTeacher.disconnected) {
            // Reconnect is for the same account only. Without this check any
            // teacher in the organisation could step into a colleague's peer
            // during the grace window and inherit their class -- and the
            // attendance record would still carry the first teacher's name.
            // A genuine handover waits for the grace timer to expire.
            if (currentTeacher.email && currentTeacher.email !== auth.email) {
              log.warn("refused reconnect into another teacher's peer", {
                meetingId,
                existing: currentTeacher.email,
                attempted: auth.email,
              });
              throw new Error("Another teacher is reconnecting to this meeting");
            }
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
            socket.join(staffRoom(room.id));
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
          email: auth.email,
        });
        room.peers.set(peer.id, peer);
        socket.data.peerId = peer.id;
        socket.data.roomId = room.id;
        socket.join(room.id);
        // Answers to questions go here and nowhere else.
        if (isStaff(peer)) socket.join(staffRoom(room.id));

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

    /** Staff put a question to the class. Everyone sees the question itself. */
    socket.on("ask-question", ({ text }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        requireStaff(peer);

        const body = String(text || "").trim().slice(0, 2000);
        if (!body) throw new Error("The question is empty");

        const question = {
          id: uuid(),
          text: body,
          from: peer.name,
          role: peer.role,
          at: Date.now(),
          closed: false,
          answers: new Map(),
        };
        room.questions.push(question);
        if (room.questions.length > 100) {
          room.questions.splice(0, room.questions.length - 100);
        }

        log.action("question-asked", { roomId: room.id, questionId: question.id, by: peer.name });
        io.to(room.id).emit("question-asked", questionPublic(question, null));
        ack(callback, { ok: true, question: questionPublic(question, peer) });
      } catch (err) {
        log.error("ask-question failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    /**
     * A student answers. The answer itself goes only to staff; the rest of the
     * class is told how many have answered and nothing more, so nobody can copy
     * and nobody is embarrassed by being wrong in front of the room.
     */
    socket.on("answer-question", ({ questionId, text }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");

        const question = room.questions.find((q) => q.id === questionId);
        if (!question) throw new Error("Question not found");
        if (question.closed) throw new Error("This question is closed");

        const body = String(text || "").trim().slice(0, 2000);
        if (!body) throw new Error("Your answer is empty");

        // Replaced rather than appended: an answer can be reworded until the
        // question closes, and staff should see one answer per student.
        const answer = {
          id: question.answers.get(peer.id)?.id || uuid(),
          questionId: question.id,
          peerId: peer.id,
          name: peer.name,
          role: peer.role,
          text: body,
          at: Date.now(),
        };
        question.answers.set(peer.id, answer);

        log.action("question-answered", {
          roomId: room.id,
          questionId: question.id,
          by: peer.name,
        });
        io.to(staffRoom(room.id)).emit("question-answer", answer);
        io.to(room.id).emit("question-answer-count", {
          questionId: question.id,
          answerCount: question.answers.size,
        });
        ack(callback, { ok: true, answer });
      } catch (err) {
        log.error("answer-question failed", err);
        ack(callback, { ok: false, error: err.message });
      }
    });

    /** Stops further answers. The question and its answers stay readable. */
    socket.on("close-question", ({ questionId }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");
        requireStaff(peer);

        const question = room.questions.find((q) => q.id === questionId);
        if (!question) throw new Error("Question not found");
        question.closed = true;

        log.action("question-closed", { roomId: room.id, questionId: question.id });
        io.to(room.id).emit("question-closed", { questionId: question.id });
        ack(callback, { ok: true });
      } catch (err) {
        log.error("close-question failed", err);
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

        // Any number of options can be correct — "select all that apply" is a
        // question in its own right, not a poll with one answer.
        const correct = [
          ...new Set(
            (Array.isArray(payload?.correct) ? payload.correct : [])
              .map((i) => Number(i))
              .filter((i) => Number.isInteger(i) && i >= 0 && i < options.length),
          ),
        ].sort((a, b) => a - b);
        if (!correct.length) throw new Error("Mark at least one correct option");

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
          correct,
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

    socket.on("vote-poll", ({ pollId, optionIndexes }, callback) => {
      try {
        const room = getRoom(socket.data.roomId);
        const peer = room?.peers.get(socket.data.peerId);
        if (!room || !peer) throw new Error("Not in a room");

        const poll = room.polls.find((p) => p.id === pollId);
        if (!poll) throw new Error("Poll not found");
        if (poll.closed || Date.now() >= poll.endsAt) throw new Error("This poll has closed");
        if (poll.votes.has(peer.id)) throw new Error("You already voted");

        // A vote is a set of choices. How many are right is never revealed, so
        // nobody can work the answer out from the number they are asked for.
        const picks = [
          ...new Set(
            (Array.isArray(optionIndexes) ? optionIndexes : [optionIndexes])
              .map((i) => Number(i))
              .filter((i) => Number.isInteger(i) && i >= 0 && i < poll.options.length),
          ),
        ].sort((a, b) => a - b);
        if (!picks.length) throw new Error("Choose at least one option");

        poll.votes.set(peer.id, picks);
        log.action("poll-vote", { roomId: room.id, pollId: poll.id, peerId: peer.id, picks });
        io.to(room.id).emit("poll-vote-count", { pollId: poll.id, totalVotes: poll.votes.size });
        ack(callback, { ok: true, optionIndexes: picks });
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
    socket.leave(staffRoom(room.id));
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
