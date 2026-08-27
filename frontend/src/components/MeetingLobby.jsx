import React, { useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { getSocket, emitAck } from "../services/socket.js";
import { readMeetingIdFromUrl, generateMeetingCode } from "../services/meetingLink.js";
import ShareLink from "./ShareLink.jsx";
import { IconShuffle } from "./Icons.jsx";

const ROLES = [
  { id: "student", label: "Student" },
  { id: "teacher", label: "Teacher" },
  { id: "coordinator", label: "Coordinator" },
];

export default function MeetingLobby({ onJoined, onJoinPayload }) {
  const { session, setSession } = useUser();
  // Read once on mount: an invite link fills the meeting for the person who
  // clicked it, so they only have to type their name.
  const [invited] = useState(() => readMeetingIdFromUrl());
  const [name, setName] = useState(session.name || "");
  const [meetingId, setMeetingId] = useState(session.meetingId || invited || "");
  // A link never carries a role. Anyone arriving by link is a student, and
  // staff pick their role by hand -- otherwise a forwarded link would hand out
  // teacher access to whoever opened it.
  const [role, setRole] = useState(session.role || "student");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const join = async (e) => {
    e.preventDefault();
    try {
      setError("");
      setBusy(true);
      console.log("[Lobby] join clicked", { name, meetingId, role });
      const socket = getSocket();
      if (!socket.connected) socket.connect();

      const waitConnect = () =>
        new Promise((resolve, reject) => {
          if (socket.connected) return resolve();
          const t = setTimeout(() => reject(new Error("Cannot reach backend on port 5000")), 8000);
          socket.once("connect", () => {
            clearTimeout(t);
            resolve();
          });
        });
      await waitConnect();

      const res = await emitAck("join-room", { name, meetingId, role });
      setSession({
        name,
        meetingId,
        role,
        peer: res.peer,
        joined: true,
      });
      onJoinPayload(res);
      onJoined();
    } catch (err) {
      console.error("[Lobby] join failed", err);
      setError(err.message || "Failed to join meeting");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <form className="lobby-card" onSubmit={join}>
        <h1>LYN MEET</h1>
        <p className="lead">LOVE YOUR NEIGHBOURHOOD's - ONLINE CLASSROOM</p>
        {error ? <div className="error-banner">{error}</div> : null}
        {notice ? <div className="notice-banner">{notice}</div> : null}
        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your display name"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="mid">Meeting ID</label>
          <div className="mid-row">
            <input
              id="mid"
              value={meetingId}
              onChange={(e) => setMeetingId(e.target.value)}
              placeholder="e.g. math-101"
              required
            />
            <button
              type="button"
              className="gen-btn"
              onClick={() => setMeetingId(generateMeetingCode())}
              title="Generate a random meeting code"
            >
              <IconShuffle size={15} />
              New code
            </button>
          </div>
          {invited && meetingId === invited ? (
            <p className="field-note">Meeting filled in from your invite link.</p>
          ) : null}
        </div>

        {meetingId.trim() ? (
          <div className="field">
            <label>Invite link</label>
            <ShareLink meetingId={meetingId.trim()} variant="full" onCopied={setNotice} />
          </div>
        ) : null}
        <div className="role-row three">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`role-btn ${role === r.id ? "active" : ""}`}
              onClick={() => setRole(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Joining…" : "Join meeting"}
        </button>
      </form>
    </div>
  );
}
