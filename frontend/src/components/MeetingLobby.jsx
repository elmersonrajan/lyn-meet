import React, { useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { getSocket, emitAck } from "../services/socket.js";
import { readMeetingIdFromUrl } from "../services/meetingLink.js";

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
  const [meetingId, setMeetingId] = useState(
    String(session.meetingId || invited || "").toUpperCase(),
  );
  // A link never carries a role. Anyone arriving by link is a student, and
  // staff pick their role by hand -- otherwise a forwarded link would hand out
  // teacher access to whoever opened it.
  const [role, setRole] = useState(session.role || "student");
  // A coordinator is an office role rather than a person, so the name is fixed.
  // The server applies the same rule, so this is convenience, not the control.
  const isCoordinator = role === "coordinator";
  const effectiveName = isCoordinator ? "ADMIN" : name;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoOk, setLogoOk] = useState(true);

  const join = async (e) => {
    e.preventDefault();
    try {
      setError("");
      setBusy(true);
      console.log("[Lobby] join clicked", { name: effectiveName, meetingId, role });
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

      const res = await emitAck("join-room", { name: effectiveName, meetingId, role });
      setSession({
        name: effectiveName,
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
      <div className="lobby-shell">
        <aside className="lobby-brand">
          <div className="brand-top">
            {/* Dropped in at public/lyn_logo_cross.png. If it is not there yet
                the mark is left out rather than showing a broken image. */}
            {logoOk ? (
              <img
                className="brand-mark"
                src="/lyn_logo_cross.png"
                alt="LYN"
                onError={() => setLogoOk(false)}
              />
            ) : null}
            <div className="brand-words">
              <h1>LYN MEET</h1>
              <p>Love Your Neighbourhood</p>
            </div>
          </div>
          <p className="brand-tagline">
            The online classroom — live teaching, a shared whiteboard, and every
            session recorded.
          </p>
        </aside>

        <form className="lobby-card" onSubmit={join}>
          <h2 className="lobby-heading">Join your class</h2>
          <p className="lead">Your teacher will have given you the meeting ID.</p>
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              value={isCoordinator ? "ADMIN" : name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your display name"
              readOnly={isCoordinator}
              required={!isCoordinator}
            />
            {isCoordinator ? (
              <p className="field-note">Coordinators always appear as ADMIN.</p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="mid">Meeting ID</label>
            {/* Meeting ids are upper case, and the server treats them that way,
                so typing in lower case would otherwise land you in an empty room
                of your own with no hint as to why. Converted as it is typed
                rather than on submit, so what you see is what you join. */}
            <input
              id="mid"
              value={meetingId}
              onChange={(e) => setMeetingId(e.target.value.toUpperCase())}
              style={{ textTransform: "uppercase" }}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. MATH-101"
              required
            />
            {invited && meetingId === invited ? (
              <p className="field-note">Meeting filled in from your invite link.</p>
            ) : null}
          </div>

          <div className="field">
            <label>Join as</label>
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
          </div>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Joining…" : "Join meeting"}
          </button>
        </form>
      </div>
    </div>
  );
}
