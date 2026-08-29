import React from "react";
import {
  IconVideo,
  IconVideoOff,
  IconMic,
  IconMicOff,
  IconMuteAll,
  IconRecord,
  IconStopRecord,
  IconPoll,
  IconChat,
  IconLeave,
  IconEndSession,
  IconClipboard,
  IconHand,
  IconHandLower,
} from "./Icons.jsx";

export default function Toolbar({
  isTeacher,
  isCoordinator,
  camOn,
  micOn,
  recording,
  recBusy,
  micLocked,
  unreadChat,
  activePoll,
  handRaised,
  raisedCount,
  onToggleCam,
  onToggleMic,
  onMuteOthers,
  onToggleRecord,
  onCloseSession,
  onOpenPolls,
  onOpenChat,
  onOpenAttendance,
  onToggleHand,
  onLowerAllHands,
  onLeave,
}) {
  const staff = isTeacher || isCoordinator;

  return (
    <div className="toolbar">
      {isTeacher ? (
        <button
          className={`tbtn ${camOn ? "on" : ""}`}
          onClick={onToggleCam}
          title={camOn ? "Turn camera off" : "Turn camera on"}
        >
          <span className="ico">{camOn ? <IconVideo /> : <IconVideoOff />}</span>
          {camOn ? "Camera On" : "Camera Off"}
        </button>
      ) : null}

      <button
        className={`tbtn ${micOn ? "on" : ""} ${micLocked ? "locked" : ""}`}
        onClick={onToggleMic}
        disabled={micLocked}
        title={
          micLocked
            ? "You can unmute only while a teacher or coordinator is in the meeting"
            : micOn
              ? "Mute your mic"
              : "Unmute your mic"
        }
      >
        <span className="ico">{micOn ? <IconMic /> : <IconMicOff />}</span>
        {micLocked ? "Mic Locked" : micOn ? "Mute" : "Unmute"}
      </button>

      <button
        className={`tbtn ${handRaised ? "raised" : ""}`}
        onClick={onToggleHand}
        title={handRaised ? "Lower your hand" : "Raise your hand"}
        aria-pressed={handRaised}
      >
        <span className="ico">
          <IconHand />
        </span>
        {handRaised ? "Lower Hand" : "Raise Hand"}
      </button>

      {staff && raisedCount > 0 ? (
        <button
          className="tbtn attn"
          onClick={onLowerAllHands}
          title={`Lower all ${raisedCount} raised hand(s)`}
        >
          <span className="ico">
            <IconHandLower />
          </span>
          Lower All
          <span className="badge">{raisedCount > 9 ? "9+" : raisedCount}</span>
        </button>
      ) : null}

      {staff ? (
        <>
          <button className="tbtn" onClick={onMuteOthers} title="Mute all students">
            <span className="ico">
              <IconMuteAll />
            </span>
            Mute All
          </button>

          <button
            className={`tbtn ${recording ? "live" : ""}`}
            onClick={onToggleRecord}
            disabled={recBusy}
            title={recording ? "Stop cloud recording" : "Start cloud recording"}
          >
            <span className="ico">{recording ? <IconStopRecord /> : <IconRecord />}</span>
            {recording ? "Stop Rec" : "Record"}
          </button>

        </>
      ) : null}

      {/* Attendance is a coordinator responsibility, not the teacher's. */}
      {isCoordinator ? (
        <button className="tbtn" onClick={onOpenAttendance} title="In/out times and duration per person">
          <span className="ico">
            <IconClipboard />
          </span>
          Attendance
        </button>
      ) : null}

      <button
        className={`tbtn ${activePoll ? "attn" : ""}`}
        onClick={onOpenPolls}
        title={staff ? "Create or review a poll" : "View the live poll"}
      >
        <span className="ico">
          <IconPoll />
        </span>
        {staff ? "New Poll" : "Poll"}
        {activePoll ? <span className="dot" /> : null}
      </button>

      <button className="tbtn" onClick={onOpenChat} title="Announcements from teaching staff">
        <span className="ico">
          <IconChat />
        </span>
        {staff ? "Announce" : "Messages"}
        {unreadChat ? <span className="badge">{unreadChat > 9 ? "9+" : unreadChat}</span> : null}
      </button>

      <span className="tspacer" />

      {staff ? (
        <button className="tbtn danger" onClick={onCloseSession} title="End the meeting for everyone">
          <span className="ico">
            <IconEndSession />
          </span>
          End Session
        </button>
      ) : null}

      <button className="tbtn danger" onClick={onLeave} title="Leave the meeting">
        <span className="ico">
          <IconLeave />
        </span>
        Leave
      </button>
    </div>
  );
}
