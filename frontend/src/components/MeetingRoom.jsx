import React, { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { emitAck } from "../services/socket.js";
import { useMediasoup } from "../hooks/useMediasoup.js";
import { useActiveSpeakers } from "../hooks/useActiveSpeakers.js";
import { useWhiteboard } from "../hooks/useWhiteboard.js";
import InstructorVideo from "./InstructorVideo.jsx";
import Participants from "./Participants.jsx";
import Toolbar from "./Toolbar.jsx";
import Whiteboard from "./Whiteboard.jsx";
import WhiteboardTabs from "./WhiteboardTabs.jsx";
import SharedMedia from "./SharedMedia.jsx";
import Appreciation from "./Appreciation.jsx";
import PresencePopup from "./PresencePopup.jsx";
import ConnectionQuality from "./ConnectionQuality.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import YouTubeDialog from "./YouTubeDialog.jsx";
import ScreenShare from "./ScreenShare.jsx";
import ChatPanel from "./ChatPanel.jsx";
import RemoteAudio from "./RemoteAudio.jsx";
import RecordingStatus from "./RecordingStatus.jsx";
import AttendancePanel from "./AttendancePanel.jsx";
import MeetingInfo from "./MeetingInfo.jsx";
import { syncUrlToMeeting } from "../services/meetingLink.js";
import { shouldReloadNow } from "../services/rejoinGuard.js";
import { APPRECIATIONS } from "../services/appreciations.js";
import { IconPen, IconScreen, IconClip, IconYouTube } from "./Icons.jsx";

export default function MeetingRoom({ socket, joinPayload, onLeft }) {
  const { session, isTeacher, isCoordinator, isStaff, setSession } = useUser();
  const [participants, setParticipants] = useState(joinPayload.participants || []);
  const [stageMode, setStageMode] = useState(joinPayload.stageMode || "whiteboard");
  const [questions, setQuestions] = useState(joinPayload.questions || []);
  const [polls, setPolls] = useState(joinPayload.polls || []);
  const [myVotes, setMyVotes] = useState(() => {
    const seed = {};
    for (const p of joinPayload.polls || []) {
      if (p.myVote != null) seed[p.id] = p.myVote;
    }
    return seed;
  });
  const [chatOpen, setChatOpen] = useState(false);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [chatTab, setChatTab] = useState("chat");
  const [unreadChat, setUnreadChat] = useState(0);
  const [recording, setRecording] = useState(Boolean(joinPayload.recording?.active));
  // Only guards the moment a request is in flight. Building the file is the
  // server's business and the teacher is never held up by it.
  const [recBusy, setRecBusy] = useState(false);
  /**
   * Which rung of the camera ladder this person is being sent, and whether the
   * server chose it for them. `automatic` is the difference between "I picked
   * audio only" and "my connection gave up", and only the second needs saying.
   */
  const [quality, setQuality] = useState({ mode: "auto", automatic: false });
  // Progress of recordings the server is still building. Purely informational:
  // the teacher may close the tab as soon as they have stopped, and the render
  // carries on regardless.
  const [recJobs, setRecJobs] = useState(joinPayload.recordingJobs || []);
  const [toast, setToast] = useState("");
  /**
   * The socket has gone and this browser is no longer part of the meeting.
   *
   * Worth its own state rather than a toast: a toast says something happened
   * four seconds ago, and this is a condition that lasts until it is fixed.
   * Everything on this screen is frozen while it is true.
   */
  const [connectionLost, setConnectionLost] = useState(false);
  const [teacherDisconnected, setTeacherDisconnected] = useState(false);
  // What the class is watching together, straight from the server: a clip
  // somebody uploaded or a YouTube video, with the position everyone shares.
  const [sharedMedia, setSharedMedia] = useState(joinPayload.media || null);
  const [mediaBusy, setMediaBusy] = useState(false);
  // Open while the teacher is being told how to share a video with its sound.
  const [videoHelpOpen, setVideoHelpOpen] = useState(false);
  const [boards, setBoards] = useState(joinPayload.boards || []);
  const [activeBoardId, setActiveBoardId] = useState(joinPayload.activeBoardId || null);
  const [boardBusy, setBoardBusy] = useState(false);
  // The board a teacher has asked to delete, held until they confirm. Its
  // drawings go with it, so this one asks first.
  const [boardToDelete, setBoardToDelete] = useState(null);
  // The praise currently on screen. One at a time: two celebrations at once
  // would be neither.
  const [award, setAward] = useState(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [ytError, setYtError] = useState("");
  const [endingSession, setEndingSession] = useState(false);
  // Who has just left, each shown for five seconds. Staff only: a student
  // watching thirty of these would be watching thirty of these.
  const [presence, setPresence] = useState([]);

  const selfId = session.peer?.id;
  const handRaised = participants.some((p) => p.id === selfId && p.handRaised);
  const raisedCount = participants.filter((p) => p.handRaised).length;
  const myReaction = participants.find((p) => p.id === selfId)?.reaction ?? null;
  const thumbsUp = participants.filter((p) => p.reaction === "up").length;
  const thumbsDown = participants.filter((p) => p.reaction === "down").length;

  const staffPresent = participants.some(
    (p) => (p.role === "teacher" || p.role === "coordinator") && !p.disconnected,
  );
  const micLocked = !isStaff && !staffPresent;
  const activePoll = polls.some((p) => !p.closed);

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(""), 4000);
  }, []);

  const speaking = useActiveSpeakers(socket);

  const media = useMediasoup({
    socket,
    role: session.role,
    peerId: session.peer?.id,
    enabled: true,
    // What to capture and how much to spend sending it, decided by the server
    // so it can be tuned for the connections the teachers actually have.
    profile: joinPayload.mediaProfile,
  });

  const board = useWhiteboard({
    socket,
    // Teacher only. A coordinator supervises and can still change the stage or
    // share a screen, but does not write on the board.
    canDraw: isTeacher,
    initial: joinPayload.whiteboard || [],
    // A picture already pasted onto the board this browser is joining into.
    initialImage: joinPayload.boardImage || null,
    // A document already open on the board this browser is joining into.
    initialDocument: joinPayload.boardDocument || null,
    // How far into the page the class is already looking.
    initialView: joinPayload.boardView || null,
    onError: showToast,
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
      /**
       * Said out loud, for five seconds.
       *
       * A name vanishing from a list of thirty is easy to miss while teaching,
       * and this is the presence a teacher actually needs to know about. Kept
       * to staff: a student would see one of these every time anybody's
       * connection hiccuped.
       */
      if (isStaff && peer.id !== session.peer?.id) {
        setPresence((prev) => [
          ...prev.slice(-3),
          {
            id: `${peer.id}-${Date.now()}`,
            name: peer.name || "Someone",
            what: peer.role === "student" ? "left the meeting" : `(${peer.role}) left the meeting`,
            at: Date.now(),
          },
        ]);
      }
    };
    const onStage = ({ mode }) => setStageMode(mode);
    // The class watches what the server says is playing, wherever it has got
    // to. All three of these carry the whole state, so a client that missed one
    // is corrected by the next rather than drifting.
    const onMediaShared = (payload) => {
      setSharedMedia(payload);
      show(payload?.kind === "youtube" ? "Playing a YouTube video" : "Playing a video");
    };
    const onMediaState = (payload) => setSharedMedia(payload);
    const onMediaStopped = () => setSharedMedia(null);
    const onBoards = ({ boards: list, activeBoardId: active }) => {
      setBoards(list || []);
      setActiveBoardId(active || null);
    };
    // The strokes travel with the switch; the board hook paints them.
    const onBoardSwitched = ({ boards: list, activeBoardId: active }) => {
      setBoards(list || []);
      setActiveBoardId(active || null);
    };
    const onAppreciation = (payload) => setAward(payload);
    const onQuestionAsked = (question) => {
      setQuestions((prev) => [...prev.filter((q) => q.id !== question.id), question]);
      setUnreadChat((n) => n + 1);
      show(isStaff ? "Question posted" : "New question from the teacher");
    };
    // Answers only ever reach staff, so this listener is silent for a student.
    const onQuestionAnswer = (answer) => {
      setQuestions((prev) =>
        prev.map((q) => {
          if (q.id !== answer.questionId) return q;
          const others = (q.answers || []).filter((a) => a.peerId !== answer.peerId);
          return { ...q, answers: [...others, answer] };
        }),
      );
    };
    const onQuestionCount = ({ questionId, answerCount }) => {
      setQuestions((prev) => prev.map((q) => (q.id === questionId ? { ...q, answerCount } : q)));
    };
    const onQuestionClosed = ({ questionId }) => {
      setQuestions((prev) => prev.map((q) => (q.id === questionId ? { ...q, closed: true } : q)));
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
    // Somebody muted this person in particular. The mic is already off by the
    // time this arrives -- the message is so they know why, and by whom.
    const onForceMute = (payload) => {
      if (payload?.reason) show(payload.reason);
    };
    const onJoinedMuted = ({ reason }) => show(reason || "You joined muted");
    const onHandChanged = (payload) => {
      // Staff get told when a hand goes up; nobody needs a toast for their own.
      if (payload.peerId === session.peer?.id) {
        if (payload.loweredBy) show(`${payload.loweredBy} lowered your hand`);
        return;
      }
      if (isStaff && payload.raised) show(`✋ ${payload.name} raised their hand`);
    };
    const onHandsCleared = ({ by, cleared }) => {
      if (cleared) show(`${by} lowered all hands (${cleared})`);
    };
    const onReactionChanged = (payload) => {
      // Only a thumbs down is worth interrupting staff for. A thumbs up is
      // good news that can wait for the count, and forty of them in a row
      // would bury everything else.
      if (payload.peerId === session.peer?.id) return;
      if (isStaff && payload.reaction === "down") show(`${payload.name} is not following`);
    };
    const onReactionsCleared = ({ by, cleared }) => {
      if (cleared) show(`${by} cleared all reactions (${cleared})`);
    };
    const onRecStart = () => {
      setRecording(true);
      show("Cloud recording started");
    };
    const onRecStop = () => {
      setRecording(false);
      show("Recording saved — the server is preparing the video");
    };
    const onRecStatus = (job) => {
      setRecJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      if (job.status === "completed") {
        show(job.file ? `Recording ready: ${job.file}` : "Recording ready");
      }
      if (job.status === "failed") {
        show(job.error ? `Recording failed: ${job.error}` : "Recording could not be prepared");
      }
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

    /**
     * The server changed what it is sending this person, or is reporting which
     * rung they are on. Only the mode is surfaced; the per-frame layer numbers
     * are useful in a log and noise on a screen.
     */
    const onQuality = ({ mode, automatic }) =>
      setQuality({ mode: mode || "auto", automatic: Boolean(automatic) });

    socket.on("video-quality", onQuality);
    socket.on("participants", onParticipants);
    socket.on("peer-joined", onJoined);
    socket.on("peer-left", onLeftPeer);
    socket.on("stage-mode", onStage);
    socket.on("question-asked", onQuestionAsked);
    socket.on("question-answer", onQuestionAnswer);
    socket.on("question-answer-count", onQuestionCount);
    socket.on("question-closed", onQuestionClosed);
    socket.on("poll-started", onPollStarted);
    socket.on("poll-ended", onPollEnded);
    socket.on("poll-vote-count", onPollCount);
    socket.on("mic-locked", onMicLocked);
    socket.on("joined-muted", onJoinedMuted);
    socket.on("hand-changed", onHandChanged);
    socket.on("hands-cleared", onHandsCleared);
    socket.on("reaction-changed", onReactionChanged);
    socket.on("reactions-cleared", onReactionsCleared);
    socket.on("force-mute", onForceMute);
    socket.on("shared-media", onMediaShared);
    socket.on("shared-media-state", onMediaState);
    socket.on("shared-media-stopped", onMediaStopped);
    socket.on("whiteboard-boards", onBoards);
    socket.on("whiteboard-switched", onBoardSwitched);
    socket.on("appreciation", onAppreciation);
    socket.on("recording-started", onRecStart);
    socket.on("recording-stopped", onRecStop);
    socket.on("recording-status", onRecStatus);
    socket.on("teacher-disconnected", onTeacherDown);
    socket.on("peer-reconnected", onTeacherBack);
    socket.on("session-closed", onClosed);
    socket.on("kicked", onKicked);
    socket.on("peer-removed", onRemoved);

    return () => {
      socket.off("video-quality", onQuality);
      socket.off("participants", onParticipants);
      socket.off("peer-joined", onJoined);
      socket.off("peer-left", onLeftPeer);
      socket.off("stage-mode", onStage);
      socket.off("question-asked", onQuestionAsked);
      socket.off("question-answer", onQuestionAnswer);
      socket.off("question-answer-count", onQuestionCount);
      socket.off("question-closed", onQuestionClosed);
      socket.off("poll-started", onPollStarted);
      socket.off("poll-ended", onPollEnded);
      socket.off("poll-vote-count", onPollCount);
      socket.off("mic-locked", onMicLocked);
      socket.off("joined-muted", onJoinedMuted);
      socket.off("hand-changed", onHandChanged);
      socket.off("reaction-changed", onReactionChanged);
      socket.off("reactions-cleared", onReactionsCleared);
      socket.off("hands-cleared", onHandsCleared);
      socket.off("force-mute", onForceMute);
      socket.off("shared-media", onMediaShared);
      socket.off("shared-media-state", onMediaState);
      socket.off("shared-media-stopped", onMediaStopped);
      socket.off("whiteboard-boards", onBoards);
      socket.off("whiteboard-switched", onBoardSwitched);
      socket.off("appreciation", onAppreciation);
      socket.off("recording-started", onRecStart);
      socket.off("recording-stopped", onRecStop);
      socket.off("recording-status", onRecStatus);
      socket.off("teacher-disconnected", onTeacherDown);
      socket.off("peer-reconnected", onTeacherBack);
      socket.off("session-closed", onClosed);
      socket.off("kicked", onKicked);
      socket.off("peer-removed", onRemoved);
    };
  }, [socket, media, onLeft, setSession, showToast, isStaff, session.peer?.id]);

  /**
   * Being cut off, and getting back in.
   *
   * A socket.io reconnect is a NEW socket: the server gives it a fresh
   * `socket.data` holding no peer and no room, and nothing in this app ever
   * re-sent `join-room`. So a single blip -- a laptop sleeping, a wifi handover,
   * a proxy timing out a websocket -- detached the browser from the meeting
   * permanently, while the screen went on showing the last thing it had heard.
   *
   * That is what a frozen participant list and a teacher who never leaves
   * actually are. The attendance panel kept working through all of it because
   * it is fetched over HTTP and asks the server every time; everything else in
   * this room is pushed down the socket, so everything else stopped.
   *
   * Rejoining is a page load rather than a hand-rolled re-init. The transports,
   * the producers and every consumer died with the old socket and would all
   * have to be rebuilt; a load does exactly that through the same path used for
   * every normal arrival, and the link in the address bar carries the class, so
   * it comes back on its own.
   */
  useEffect(() => {
    if (!socket) return undefined;

    const onDown = () => {
      console.warn("[MeetingRoom] socket lost — this browser is no longer in the meeting");
      setConnectionLost(true);
    };

    /**
     * Only ever a RE-connect here: the first one happened in the lobby, before
     * this component existed.
     */
    const onBack = () => {
      console.warn("[MeetingRoom] socket back on a new id — rejoining");
      syncUrlToMeeting(session.meetingId);
      if (!shouldReloadNow()) {
        // Reloading again this soon would be a loop on a flapping line. The
        // bar stays up with a button, so it is their choice and not a cycle.
        setConnectionLost(true);
        return;
      }
      window.location.reload();
    };

    socket.on("disconnect", onDown);
    socket.on("connect", onBack);
    return () => {
      socket.off("disconnect", onDown);
      socket.off("connect", onBack);
    };
  }, [socket, session.meetingId]);

  const setStage = async (mode) => {
    try {
      if (!isTeacher) return;
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

  // One request at a time. Every extra press used to reach the server as another
  // full stop of the same recording, which is what corrupted the file and
  // overloaded the box.
  const onToggleRecord = async () => {
    if (!isStaff || recBusy) return;
    setRecBusy(true);
    try {
      if (recording) {
        await emitAck("stop-recording", {});
        setRecording(false);
      } else {
        /**
         * Nothing is captured from this browser.
         *
         * The recording is built on the server, the way Meet and Zoom build
         * theirs: the board is drawn there from the strokes and the page under
         * them, the camera and the microphones arrive as the streams they
         * already are. Pressing record used to open the browser's screen
         * picker first, which is a thing to get wrong in front of a class.
         */
        await emitAck("start-recording", {});
      }
    } catch (err) {
      console.error("[MeetingRoom] record toggle failed", err);
      setToast(err.message);
    } finally {
      setRecBusy(false);
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

  // A teacher who typed the meeting ID rather than following a link would
  // otherwise sit on a bare origin with nothing shareable in the address bar.
  useEffect(() => {
    syncUrlToMeeting(session.meetingId);
  }, [session.meetingId]);

  const onToggleHand = async () => {
    try {
      await emitAck("raise-hand", { raised: !handRaised });
    } catch (err) {
      console.error("[MeetingRoom] raise hand failed", err);
      showToast(err.message);
    }
  };

  const onReact = async (reaction) => {
    try {
      // The server treats a repeat of the thumb you already show as taking it
      // back, so this one call covers setting, switching and clearing.
      await emitAck("set-reaction", { reaction });
    } catch (err) {
      console.error("[MeetingRoom] set reaction failed", err);
      showToast(err.message);
    }
  };

  const onClearReactions = async () => {
    try {
      const res = await emitAck("clear-reactions", {});
      showToast(res.cleared ? `Cleared ${res.cleared} reaction(s)` : "No reactions to clear");
    } catch (err) {
      console.error("[MeetingRoom] clear reactions failed", err);
      showToast(err.message);
    }
  };

  const onLowerHand = async (peerId) => {
    try {
      await emitAck("lower-hand", { peerId });
    } catch (err) {
      console.error("[MeetingRoom] lower hand failed", err);
      showToast(err.message);
    }
  };

  const onLowerAllHands = async () => {
    try {
      await emitAck("lower-all-hands", {});
    } catch (err) {
      console.error("[MeetingRoom] lower all hands failed", err);
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

  /**
   * Ending the session throws the whole class out of the lesson, and the button
   * sits beside Leave. Asking first costs a second; getting it wrong costs the
   * rest of the lesson, because there is no way to call everyone back.
   */
  const onCloseSession = () => setConfirmEnd(true);

  const confirmCloseSession = async () => {
    setEndingSession(true);
    try {
      await emitAck("close-session", {});
      setConfirmEnd(false);
    } catch (err) {
      console.error("[MeetingRoom] close session failed", err);
      setToast(err.message);
    } finally {
      setEndingSession(false);
    }
  };

  /**
   * A clip is uploaded before it is shared.
   *
   * The old behaviour made a blob URL, which exists in exactly one browser:
   * the teacher watched the video and the class watched an empty stage. Now the
   * file goes to the server once and every browser plays it from there -- which
   * is what gets the sound to the students, at their own volume, in their own
   * quality.
   */
  /**
   * Playing a video to the class is a screen share of the tab it is playing in.
   *
   * Uploading the file was the other way round -- send it to the server, have
   * every browser fetch it back -- and it ran into the one limit that has
   * nothing to do with this application: what the proxy in front of the server
   * will accept. Sharing the tab has no size limit at all, works for a video
   * that is not a file, and carries the original sound.
   *
   * The dialog exists for one reason: the audio tickbox in Chrome's picker is
   * easy to miss, and a silent video is the failure this feature is for.
   */
  const playVideo = async () => {
    if (!isTeacher) return;
    setVideoHelpOpen(false);
    setMediaBusy(true);
    try {
      await media.startScreen({ preferTab: true });
      await emitAck("set-stage", { mode: "screen" });
      setStageMode("screen");
    } catch (err) {
      console.error("[MeetingRoom] play video failed", err);
      // A teacher who closes the picker has not hit an error, they have
      // changed their mind.
      if (err.name !== "NotAllowedError") setToast(err.message);
    } finally {
      setMediaBusy(false);
    }
  };

  /**
   * A YouTube link, checked by the server before it reaches anybody's screen.
   *
   * The prompt is deliberately plain: the teacher pastes what they copied out
   * of YouTube, in any of the shapes YouTube hands out, and the server reduces
   * it to a video id or refuses it.
   */
  const shareYouTube = async (url) => {
    if (!isTeacher) return;
    setMediaBusy(true);
    setYtError("");
    try {
      await emitAck("share-media", { kind: "youtube", url });
      setYtOpen(false);
    } catch (err) {
      console.error("[MeetingRoom] youtube share failed", err);
      // Shown in the dialog rather than as a toast: the teacher is still
      // holding the link they need to correct.
      setYtError(err.message);
    } finally {
      setMediaBusy(false);
    }
  };

  /** Play, pause and seek, from the staff player to everyone else's. */
  const onMediaControl = async ({ action, positionSec }) => {
    if (!isTeacher) return;
    try {
      await emitAck("media-control", { action, positionSec });
    } catch (err) {
      console.error("[MeetingRoom] media control failed", err);
    }
  };

  const stopMedia = async () => {
    if (!isTeacher) return;
    try {
      await emitAck("stop-media", {});
    } catch (err) {
      console.error("[MeetingRoom] stop media failed", err);
      setToast(err.message);
    }
  };

  /**
   * A new board, with the old one kept.
   *
   * The server answers with the tabs and everyone is moved to the new page
   * together, so the class never ends up looking at a board the teacher has
   * left.
   */
  const addBoard = async () => {
    if (!isTeacher || boardBusy) return;
    setBoardBusy(true);
    try {
      await emitAck("whiteboard-add", {});
      if (stageMode !== "whiteboard" && stageMode !== "draw") await setStage("whiteboard");
    } catch (err) {
      console.error("[MeetingRoom] add board failed", err);
      setToast(err.message);
    } finally {
      setBoardBusy(false);
    }
  };

  const selectBoard = async (boardId) => {
    if (!isTeacher || boardBusy || boardId === activeBoardId) return;
    setBoardBusy(true);
    try {
      await emitAck("whiteboard-select", { boardId });
    } catch (err) {
      console.error("[MeetingRoom] select board failed", err);
      setToast(err.message);
    } finally {
      setBoardBusy(false);
    }
  };

  /**
   * Deleting a board takes everything drawn on it, which is why it asks first.
   *
   * The server chooses where the class lands afterwards and tells everybody,
   * so there is no local guess about which board is now live.
   */
  const removeBoard = async () => {
    const target = boardToDelete;
    if (!isTeacher || !target) return;
    setBoardBusy(true);
    try {
      await emitAck("whiteboard-remove", { boardId: target.id });
      setBoardToDelete(null);
    } catch (err) {
      console.error("[MeetingRoom] remove board failed", err);
      setToast(err.message);
    } finally {
      setBoardBusy(false);
    }
  };

  /** Praise the class, not one screen: the server puts it on everyone's. */
  const sendAppreciation = async (id) => {
    if (!isStaff) return;
    try {
      await emitAck("appreciate", { id });
    } catch (err) {
      console.error("[MeetingRoom] appreciation failed", err);
      setToast(err.message);
    }
  };

  /**
   * Mutes one student.
   *
   * Only mutes. Turning somebody's microphone back on for them would decide
   * on their behalf that their room is being listened to again, which is not a
   * teacher's decision to make -- the student unmutes themselves.
   */
  const onMuteOne = async (peerId) => {
    if (!isStaff) return;
    try {
      await emitAck("mute-participant", { peerId });
    } catch (err) {
      console.error("[MeetingRoom] mute participant failed", err);
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

  /**
   * This person choosing for themselves, which also cancels whatever the
   * server decided -- so somebody dropped to audio can ask for the picture
   * back without waiting out the retry.
   */
  const onChangeQuality = async (mode) => {
    try {
      const res = await emitAck("set-video-quality", { mode });
      setQuality({ mode: res?.mode || mode, automatic: false });
    } catch (err) {
      console.error("[MeetingRoom] set-video-quality failed", err);
      showToast(err.message);
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

  // "media" is the stage mode the server sets when something is shared; a
  // client that has the media but an older stage mode still shows it, so a
  // missed stage-mode message cannot leave the class staring at a blank board.
  /**
   * Having the video is enough to show it.
   *
   * Requiring the stage mode to agree as well meant two separate messages both
   * had to arrive: a client that got "something is playing" but missed the
   * stage change showed neither the board nor the video, which is a blank white
   * stage and no way to tell why. The video is only stood down for the two
   * things that deliberately replace it.
   */
  const showMedia = Boolean(sharedMedia) && stageMode !== "screen" && stageMode !== "draw";
  const onBoard = !showMedia && stageMode !== "screen";

  const teacherPeer = participants.find((p) => p.role === "teacher");
  const teacherName = teacherPeer?.name || "Teacher";
  /**
   * Read from the roster rather than from a socket event, because the roster
   * is also what a late joiner is handed: somebody arriving while the camera
   * is already off must see it as off, not as a tile that never paints.
   *
   * The teacher's own tile goes by camOn instead — their track is stopped
   * locally the moment they press the button, which is sooner than the server
   * can tell them what they already know.
   */
  const teacherCamOff = Boolean(teacherPeer?.videoOff);
  /**
   * Two ways of learning the same thing, because one message can be missed.
   *
   * `teacher-disconnected` is sent once, to whoever is in the room at that
   * moment; the flag on the participant row comes with every roster update, so
   * it also reaches anyone who arrives mid-gap or reconnects during it. Either
   * is enough to stand the tile down.
   */
  const teacherAway = teacherDisconnected || Boolean(teacherPeer?.disconnected);
  const instructorStream = isTeacher
    ? media.camOn
      ? media.localStream
      : null
    : teacherCamOff
      ? null
      : media.teacherStream;

  return (
    <div className="room">
      <RemoteAudio items={media.remoteAudio} />
      <div className="room-frame">
        <div className="stage-wrap">
          {/*
            One strip across the top: the whiteboard tabs on the left, taking
            whatever width is left, and the stage controls on the right.

            The controls used to float over the stage, which put them in the
            same band as the tab bar -- so from the fourth board on, the tabs
            ran underneath them and the active tab could be hidden completely.
          */}
          <div className="stage-head">
            {onBoard ? (
              <WhiteboardTabs
                boards={boards}
                activeId={activeBoardId}
                canEdit={isTeacher}
                busy={boardBusy}
                onSelect={selectBoard}
                onAdd={addBoard}
                onRemove={(id, name) => setBoardToDelete({ id, name })}
              />
            ) : null}
            {/*
              The teacher's, not staff's.

              A coordinator supervises a class; they do not teach it. They
              cannot draw either -- the board has been teacher-only for a while
              -- so a Draw tab that switches the whole class to a page they are
              unable to write on is a button that only does harm, and Screen,
              Play Video and YouTube take the lesson off the teacher mid-flow.
              Their own tools are all in the bar along the bottom.
            */}
            {isTeacher ? (
              <div className="stage-tools">
                <button
                  className={stageMode === "draw" || stageMode === "whiteboard" ? "active" : ""}
                  onClick={() => setStage("draw")}
                >
                  <IconPen size={16} />
                  Draw
                </button>
                <button className={stageMode === "screen" ? "active" : ""} onClick={() => setStage("screen")}>
                  <IconScreen size={16} />
                  Screen
                </button>
                <button
                  className={mediaBusy ? "busy" : ""}
                  onClick={() => setVideoHelpOpen(true)}
                  disabled={mediaBusy}
                  title="Play a video to the class from a browser tab, with its sound"
                >
                  <IconClip size={16} />
                  Play Video
                </button>
                <button
                  className={showMedia && sharedMedia?.kind === "youtube" ? "active" : ""}
                  onClick={() => {
                    setYtError("");
                    setYtOpen(true);
                  }}
                  disabled={mediaBusy}
                  title="Play a YouTube video for the class"
                >
                  <IconYouTube size={16} />
                  YouTube
                </button>
                {/* Drawing over a video is a normal thing to do mid-lesson, and
                    without this the only way back to it would be to share it
                    again from the start. */}
                {sharedMedia && !showMedia ? (
                  <button onClick={() => setStage("media")} title="Back to the video">
                    <IconClip size={16} />
                    Back to video
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="stage-canvas">
            {/* Inside the canvas, not the stage: from out here they would sit
                on top of the tab bar. */}
            {recording ? <div className="rec-pill">REC CLOUD</div> : null}
            {isStaff ? <RecordingStatus jobs={recJobs} /> : null}
            <div style={{ display: onBoard ? "block" : "none", width: "100%", height: "100%" }}>
              <Whiteboard
                board={board}
                // The right-click menu offers these two, because a teacher
                // who wants to "put a video on the board" is looking at the
                // board when they think it.
                onPlayVideo={isTeacher ? () => setVideoHelpOpen(true) : null}
                onYouTube={
                  isTeacher
                    ? () => {
                        setYtError("");
                        setYtOpen(true);
                      }
                    : null
                }
              />
            </div>
            {stageMode === "screen" && media.screenStream ? (
              <ScreenShare stream={media.screenStream} />
            ) : showMedia ? (
              <SharedMedia
                media={sharedMedia}
                // The teacher drives; everyone else follows. A second pair of
                // hands on the scrubber is a class that has stopped watching
                // the same thing.
                canControl={isTeacher}
                onControl={onMediaControl}
                onStop={stopMedia}
              />
            ) : null}
          </div>
        </div>
        <aside className="side">
          <MeetingInfo meetingId={session.meetingId} />
          <InstructorVideo
            stream={instructorStream}
            name={teacherName}
            disconnected={teacherAway}
            muted={isTeacher}
            // Only when this is the teacher's own camera. The same tile shows
            // the teacher to everyone else, and flipping it for them would put
            // any writing held up to the camera backwards.
            mirror={isTeacher}
          />
          <Participants
            list={participants}
            canRemove={isStaff}
            selfId={selfId}
            speaking={speaking}
            onRemove={onRemove}
            onMute={onMuteOne}
            onLowerHand={onLowerHand}
          />
        </aside>
      </div>

      <Toolbar
        isTeacher={isTeacher}
        isCoordinator={isCoordinator}
        camOn={media.camOn}
        micOn={media.micOn}
        recording={recording}
        recBusy={recBusy}
        micLocked={micLocked}
        unreadChat={unreadChat}
        activePoll={activePoll}
        handRaised={handRaised}
        raisedCount={raisedCount}
        myReaction={myReaction}
        thumbsUp={thumbsUp}
        thumbsDown={thumbsDown}
        onReact={onReact}
        onClearReactions={onClearReactions}
        onToggleCam={media.toggleCam}
        onToggleMic={onToggleMic}
        onMuteOthers={onMuteOthers}
        onToggleRecord={onToggleRecord}
        onCloseSession={onCloseSession}
        appreciations={APPRECIATIONS}
        onAppreciate={sendAppreciation}
        onOpenPolls={() => {
          setChatTab("poll");
          setChatOpen(true);
        }}
        onOpenChat={() => {
          setChatTab("chat");
          setChatOpen(true);
          setUnreadChat(0);
        }}
        onOpenAttendance={() => setAttendanceOpen(true)}
        onToggleHand={onToggleHand}
        onLowerAllHands={onLowerAllHands}
        onLeave={onLeave}
      />

      {/* Only shown once something is not "just working": an automatic drop to
          audio, or a choice this person made. A control nobody needs should
          not be on screen during a lesson. */}
      {quality.mode !== "auto" ? (
        <ConnectionQuality
          mode={quality.mode}
          automatic={quality.automatic}
          onChange={onChangeQuality}
        />
      ) : null}

      <AttendancePanel
        open={attendanceOpen && isCoordinator}
        meetingId={session.meetingId}
        onClose={() => setAttendanceOpen(false)}
        onError={showToast}
      />

      <ChatPanel
        open={chatOpen}
        tab={chatTab}
        onTab={(t) => {
          setChatTab(t);
          if (t === "chat") setUnreadChat(0);
        }}
        onClose={() => setChatOpen(false)}
        questions={questions}
        polls={polls}
        myVotes={myVotes}
        isStaff={isStaff}
        onVoted={(pollId, picks) => setMyVotes((prev) => ({ ...prev, [pollId]: picks }))}
        onAnswered={(questionId, answer) =>
          setQuestions((prev) =>
            prev.map((q) => (q.id === questionId ? { ...q, myAnswer: answer } : q)),
          )
        }
        onError={showToast}
      />
      {connectionLost ? (
        <div className="conn-lost" role="alert">
          <span>Connection lost — you are no longer in the meeting.</span>
          <button
            onClick={() => {
              syncUrlToMeeting(session.meetingId);
              window.location.reload();
            }}
          >
            Rejoin
          </button>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}

      {/* Above everything, briefly, for everyone in the room. */}
      <Appreciation award={award} onDone={() => setAward(null)} />

      <PresencePopup
        events={presence}
        onExpire={(id) => setPresence((prev) => prev.filter((e) => e.id !== id))}
      />

      {/*
        The one thing that goes wrong when a teacher shares a video: Chrome's
        audio tickbox is easy to miss, and the class then watches in silence.
      */}
      <ConfirmDialog
        open={videoHelpOpen && isStaff}
        title="Play a video to the class"
        message="Open the video in another browser tab, then choose that tab here — and tick 'Also share tab audio', or the class will see the video without hearing it."
        confirmLabel="Choose the tab"
        cancelLabel="Cancel"
        busy={mediaBusy}
        onConfirm={playVideo}
        onCancel={() => setVideoHelpOpen(false)}
      />

      <YouTubeDialog
        open={ytOpen && isStaff}
        busy={mediaBusy}
        error={ytError}
        onPlay={shareYouTube}
        onCancel={() => setYtOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(boardToDelete) && isTeacher}
        title={`Delete ${boardToDelete?.name || "this whiteboard"}?`}
        message="Everything drawn on it will be lost, for everyone. The other whiteboards are not affected."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        busy={boardBusy}
        onConfirm={removeBoard}
        onCancel={() => setBoardToDelete(null)}
      />

      <ConfirmDialog
        open={confirmEnd}
        title="End the meeting for everyone?"
        message="Every participant will be removed from the meeting and the session will be closed. This cannot be undone."
        confirmLabel="End Meeting"
        cancelLabel="Cancel"
        danger
        busy={endingSession}
        onConfirm={confirmCloseSession}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}
