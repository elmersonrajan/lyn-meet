import React, { useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { getSocket, emitAck } from "../services/socket.js";

export default function MeetingLobby({ onJoined, onJoinPayload }) {
  const { session, setSession } = useUser();
  const [name, setName] = useState(session.name || "");
  const [meetingId, setMeetingId] = useState(session.meetingId || "");
  const [role, setRole] = useState(session.role || "student");
  const [error, setError] = useState("");
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
        <h1>Classroom Meet</h1>
        <p className="lead">Enter your name and meeting ID, then join as teacher or student.</p>
        {error ? <div className="error-banner">{error}</div> : null}
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
          <input
            id="mid"
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            placeholder="e.g. math-101"
            required
          />
        </div>
        <div className="role-row">
          <button
            type="button"
            className={`role-btn ${role === "teacher" ? "active" : ""}`}
            onClick={() => setRole("teacher")}
          >
            Teacher
          </button>
          <button
            type="button"
            className={`role-btn ${role === "student" ? "active" : ""}`}
            onClick={() => setRole("student")}
          >
            Student
          </button>
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Joining…" : "Join meeting"}
        </button>
      </form>
    </div>
  );
}
