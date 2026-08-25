import React, { useCallback, useEffect, useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { emitAck } from "../services/socket.js";
import { useMediasoup } from "../hooks/useMediasoup.js";
import { useWhiteboard } from "../hooks/useWhiteboard.js";
import InstructorVideo from "./InstructorVideo.jsx";
import Participants from "./Participants.jsx";
import Toolbar from "./Toolbar.jsx";
import Whiteboard from "./Whiteboard.jsx";
import ScreenShare from "./ScreenShare.jsx";
import ChatPanel from "./ChatPanel.jsx";
import RemoteAudio from "./RemoteAudio.jsx";
import { IconPen, IconScreen, IconBoard, IconClip } from "./Icons.jsx";

export default function MeetingRoom({ socket, joinPayload, onLeft }) {
  const { session, isTeacher, isCoordinator, isStaff, setSession } = useUser();
  const [participants, setParticipants] = useState(joinPayload.participants || []);
  const [stageMode, setStageMode] = useState(joinPayload.stageMode || "whiteboard");
  const [messages, setMessages] = useState(joinPayload.chat || []);
  const [polls, setPolls] = useState(joinPayload.polls || []);
  const [myVotes, setMyVotes] = useState(() => {
    const seed = {};
    for (const p of joinPayload.polls || []) {
      if (p.myVote != null) seed[p.id] = p.myVote;
    }
    return seed;
  });
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTab, setChatTab] = useState("chat");
  const [unreadChat, setUnreadChat] = useState(0);
  const [recording, setRecording] = useState(Boolean(joinPayload.recording?.active));
  const [toast, setToast] = useState("");
  const [clipUrl, setClipUrl] = useState("");
  const [teacherDisconnected, setTeacherDisconnected] = useState(false);

  const staffPresent = participants.some(
    (p) => (p.role === "teacher" || p.role === "coordinator") && !p.disconnected,
  );
  const micLocked = !isStaff && !staffPresent;
  const activePoll = polls.some((p) => !p.closed);

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(""), 4000);
  }, []);

  const media = useMediasoup({
    socket,
    role: session.role,
    peerId: session.peer?.id,
    enabled: true,
  });

  const board = useWhiteboard({
    socket,
    canDraw: isStaff,
    initial: joinPayload.whiteboard || [],
  });

  useEffect(() => {
    if (stageMode === "whiteboard" || stageMode === "draw") {
      requestAnimationFrame(() => {
        board.fitCanvas?.();
      });
    }
  }, [stageMode, board]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        console.log("[MeetingRoom] initializing mediasoup", { role: session.role });
        await media.initDevice({
          routerRtpCapabilities: joinPayload.routerRtpCapabilities,
          iceServers: joinPayload.iceServers,
        });
        if (!cancelled) {
          await media.consumeExisting(joinPayload.producers || []);
        }
      } catch (err) {
        console.error("[MeetingRoom] media init failed", err);
        setToast(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const show = showToast;

    const onParticipants = (list) => setParticipants(list);
    const onJoined = (peer) => {
      console.log("[MeetingRoom] peer-joined", peer);
      setParticipants((prev) => {
        if (prev.some((p) => p.id === peer.id)) return prev;
        return [...prev, peer];
      });
    };
    const onLeftPeer = (peer) => {
      console.log("[MeetingRoom] peer-left", peer);
      setParticipants((prev) => prev.filter((p) => p.id !== peer.id));
      if (peer.role === "teacher") setTeacherDisconnected(false);
    };
    const onStage = ({ mode }) => setStageMode(mode);
    const onChat = (msg) => {
      setMessages((prev) => [...prev, msg]);
      setUnreadChat((n) => n + 1);
    };
    const onPollStarted = (poll) => {
      setPolls((prev) => [...prev.filter((p) => p.id !== poll.id), poll]);
      show(`New poll: ${poll.question}`);
    };
    const onPollEnded = (poll) => {
      setPolls((prev) => prev.map((p) => (p.id === poll.id ? poll : p)));
      show("Poll closed — results are in");
    };
    const onPollCount = ({ pollId, totalVotes }) => {
      setPolls((prev) => prev.map((p) => (p.id === pollId ? { ...p, totalVotes } : p)));
    };
    const onMicLocked = ({ reason }) => show(reason || "Mic disabled");
    const onRecStart = () => {
      setRecording(true);
      show("Cloud recording started");
    };
    const onRecStop = () => {
      setRecording(false);
      show("Cloud recording saved on server");
    };
    const onTeacherDown = (payload) => {
      setTeacherDisconnected(true);
      show(payload.message || "Teacher disconnected — meeting continues");
    };
    const onTeacherBack = () => {
      setTeacherDisconnected(false);
      show("Teacher reconnected");
    };
    const onClosed = ({ reason }) => {
      show(reason || "Session closed");
      media.cleanup();
      setSession((s) => ({ ...s, joined: false }));
      onLeft();
    };
    const onKicked = ({ reason }) => {
      show(reason || "Removed from meeting");
      media.cleanup();
      setSession((s) => ({ ...s, joined: false }));
      onLeft();
    };
    const onRemoved = ({ peer, by }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== peer.id));
      show(`${peer.name} was removed by ${by}`);
    };

    socket.on("participants", onParticipants);
    socket.on("peer-joined", onJoined);
    socket.on("peer-left", onLeftPeer);
    socket.on("stage-mode", onStage);
    socket.on("chat-message", onChat);
    socket.on("poll-started", onPollStarted);
    socket.on("poll-ended", onPollEnded);
    socket.on("poll-vote-count", onPollCount);
    socket.on("mic-locked", onMicLocked);
    socket.on("recording-started", onRecStart);
    socket.on("recording-stopped", onRecStop);
    socket.on("teacher-disconnected", onTeacherDown);
    socket.on("peer-reconnected", onTeacherBack);
    socket.on("session-closed", onClosed);
    socket.on("kicked", onKicked);
    socket.on("peer-removed", onRemoved);

    return () => {
      socket.off("participants", onParticipants);
      socket.off("peer-joined", onJoined);
      socket.off("peer-left", onLeftPeer);
      socket.off("stage-mode", onStage);
      socket.off("chat-message", onChat);
      socket.off("poll-started", onPollStarted);
      socket.off("poll-ended", onPollEnded);
      socket.off("poll-vote-count", onPollCount);
      socket.off("mic-locked", onMicLocked);
      socket.off("recording-started", onRecStart);
      socket.off("recording-stopped", onRecStop);
      socket.off("teacher-disconnected", onTeacherDown);
      socket.off("peer-reconnected", onTeacherBack);
      socket.off("session-closed", onClosed);
      socket.off("kicked", onKicked);
      socket.off("peer-removed", onRemoved);
    };
  }, [socket, media, onLeft, setSession, showToast]);

  const setStage = async (mode) => {
    try {
      if (!isStaff) return;
      console.log("[MeetingRoom] setStage", mode);
      if (mode === "screen") {
        if (!media.sharing) await media.startScreen();
      }
      await emitAck("set-stage", { mode });
      setStageMode(mode);
    } catch (err) {
      console.error("[MeetingRoom] setStage failed", err);
      setToast(err.message);
    }
  };

  const onToggleRecord = async () => {
    try {
      if (!isStaff) return;
      if (recording) {
        await emitAck("stop-recording", {});
      } else {
        await emitAck("start-recording", {});
      }
    } catch (err) {
      console.error("[MeetingRoom] record toggle failed", err);
      setToast(err.message);
    }
  };

  const onToggleMic = async () => {
    try {
      if (micLocked) {
        showToast("Wait for a teacher or coordinator to join before unmuting");
        return;
      }
      await media.toggleMic();
    } catch (err) {
      console.error("[MeetingRoom] mic toggle failed", err);
      showToast(err.message);
    }
  };

  const onMuteOthers = async () => {
    try {
      await emitAck("mute-others", {});
      setToast("All students muted");
    } catch (err) {
      console.error("[MeetingRoom] mute others failed", err);
      setToast(err.message);
    }
  };

  const onCloseSession = async () => {
    try {
      await emitAck("close-session", {});
    } catch (err) {
      console.error("[MeetingRoom] close session failed", err);
      setToast(err.message);
    }
  };

  const onRemove = async (peerId) => {
    try {
      await emitAck("remove-participant", { peerId });
    } catch (err) {
      console.error("[MeetingRoom] remove failed", err);
      setToast(err.message);
    }
  };

  const onLeave = async () => {
    try {
      await emitAck("leave-room", {});
    } catch (err) {
      console.error("[MeetingRoom] leave failed", err);
    } finally {
      media.cleanup();
      setSession((s) => ({ ...s, joined: false }));
      onLeft();
    }
  };

  const pickClip = async (e) => {
    try {
      if (!isStaff) return;
      const file = e.target.files?.[0];
      if (!file) return;
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      const url = URL.createObjectURL(file);
      setClipUrl(url);
      await emitAck("set-stage", { mode: "clip" });
      setStageMode("clip");
    } catch (err) {
      console.error("[MeetingRoom] pickClip failed", err);
    }
  };

  const teacherName = participants.find((p) => p.role === "teacher")?.name || "Teacher";

  return (
    <div className="room">
      <RemoteAudio items={media.remoteAudio} />
      <div className="room-frame">
        <div className="stage-wrap">
          {recording ? <div className="rec-pill">REC CLOUD</div> : null}
          {isStaff ? (
            <div className="stage-tools">
              <button className={stageMode === "draw" ? "active" : ""} onClick={() => setStage("draw")}>
                <IconPen size={16} />
                Draw
              </button>
              <button
                className={stageMode === "whiteboard" ? "active" : ""}
                onClick={() => setStage("whiteboard")}
              >
                <IconBoard size={16} />
                Whiteboard
              </button>
              <button className={stageMode === "screen" ? "active" : ""} onClick={() => setStage("screen")}>
                <IconScreen size={16} />
                Screen
              </button>
              <label className={stageMode === "clip" ? "active" : ""}>
                <IconClip size={16} />
                Video Clip
                <input type="file" accept="video/*" hidden onChange={pickClip} />
              </label>
            </div>
          ) : null}
          <div className="stage-canvas">
            <div style={{ display: stageMode === "whiteboard" || stageMode === "draw" ? "block" : "none", width: "100%", height: "100%" }}>
              <Whiteboard board={board} />
            </div>
            {stageMode === "screen" && media.screenStream ? (
              <ScreenShare stream={media.screenStream} />
            ) : stageMode === "clip" && clipUrl ? (
              <video className="clip" src={clipUrl} controls autoPlay />
            ) : null}
          </div>
        </div>
        <aside className="side">
          <InstructorVideo
            stream={isTeacher ? media.localStream : media.teacherStream}
            name={teacherName}
            disconnected={teacherDisconnected}
            muted={isTeacher}
          />
          <Participants
            list={participants}
            canRemove={isStaff}
            selfId={session.peer?.id}
            onRemove={onRemove}
          />
        </aside>
      </div>

      <Toolbar
        isTeacher={isTeacher}
        isCoordinator={isCoordinator}
        camOn={media.camOn}
        micOn={media.micOn}
        recording={recording}
        micLocked={micLocked}
        unreadChat={unreadChat}
        activePoll={activePoll}
        onToggleCam={media.toggleCam}
        onToggleMic={onToggleMic}
        onMuteOthers={onMuteOthers}
        onToggleRecord={onToggleRecord}
        onCloseSession={onCloseSession}
        onOpenPolls={() => {
          setChatTab("poll");
          setChatOpen(true);
        }}
        onOpenChat={() => {
          setChatTab("chat");
          setChatOpen(true);
          setUnreadChat(0);
        }}
        onLeave={onLeave}
      />

      <ChatPanel
        open={chatOpen}
        tab={chatTab}
        onTab={(t) => {
          setChatTab(t);
          if (t === "chat") setUnreadChat(0);
        }}
        onClose={() => setChatOpen(false)}
        messages={messages}
        polls={polls}
        myVotes={myVotes}
        isStaff={isStaff}
        onVoted={(pollId, index) => setMyVotes((prev) => ({ ...prev, [pollId]: index }))}
        onError={showToast}
      />
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
