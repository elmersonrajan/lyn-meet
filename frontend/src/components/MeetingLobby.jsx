import React, { useEffect, useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { getSocket, emitAck } from "../services/socket.js";
import { readMeetingIdFromUrl } from "../services/meetingLink.js";
import { fetchMe, goToLogin, logout, redeemHandoffToken } from "../services/auth.js";

/** Shown against the person's name so they can see how they will appear. */
const ROLE_LABELS = {
  student: "Student",
  teacher: "Teacher",
  coordinator: "Coordinator",
};

export default function MeetingLobby({ onJoined, onJoinPayload }) {
  const { session, setSession } = useUser();
  // Read once on mount: an invite link fills the meeting for the person who
  // clicked it, so they only have to press Join.
  const [invited] = useState(() => readMeetingIdFromUrl());
  const [meetingId, setMeetingId] = useState(
    String(session.meetingId || invited || "").toUpperCase(),
  );
  // Who the server says we are. Null until the check completes; a failed check
  // sends the browser to lynindia.in rather than rendering a form.
  const [me, setMe] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoOk, setLogoOk] = useState(true);

  /**
   * The name and role fields are gone on purpose. They were the whole
   * vulnerability: anyone could type "teacher" and run someone else's class.
   * Identity now arrives from the platform session and is re-checked on the
   * server for every socket connection, so there is nothing here to fill in.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // A hand-off token in the URL takes priority: it is single-use, so it
        // has to be redeemed on this page load or it is wasted. Only if there
        // is no token do we fall back to asking about an existing cookie.
        let user = await redeemHandoffToken();
        if (cancelled) return;
        if (!user) user = await fetchMe();
        if (cancelled) return;
        if (!user) {
          goToLogin();
          return;
        }
        setMe(user);
        setSession((s) => ({ ...s, name: user.name, role: user.role, email: user.email }));
      } catch (err) {
        if (cancelled) return;
        // A stale or already-used link is worth another trip through the main
        // site; a refused account is not, and the reason is shown instead.
        if (err.recoverable) {
          goToLogin();
          return;
        }
        setError(err.message || "Could not verify your sign-in");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession]);

  const join = async (e) => {
    e.preventDefault();
    try {
      setError("");
      setBusy(true);
      const socket = getSocket();
      if (!socket.connected) socket.connect();

      const waitConnect = () =>
        new Promise((resolve, reject) => {
          if (socket.connected) return resolve();
          const timer = setTimeout(
            () => reject(new Error("Cannot reach the meeting server")),
            8000,
          );
          const onError = (err) => {
            clearTimeout(timer);
            socket.off("connect", onConnect);
            // The handshake is where the session is checked, so a refusal here
            // means signed out or not authorised -- not a network fault.
            const code = err?.data?.code;
            if (code === "NO_SESSION") {
              goToLogin();
              return;
            }
            reject(new Error(err?.message || "Connection refused"));
          };
          const onConnect = () => {
            clearTimeout(timer);
            socket.off("connect_error", onError);
            resolve();
          };
          socket.once("connect", onConnect);
          socket.once("connect_error", onError);
        });
      await waitConnect();

      // Only the meeting is sent. Name and role are the server's to decide.
      const res = await emitAck("join-room", { meetingId });
      setSession({
        name: res.peer?.name || me.name,
        email: me.email,
        meetingId,
        role: res.peer?.role || me.role,
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

  if (checking) {
    return (
      <div className="lobby">
        <div className="lobby-shell">
          <div className="lobby-card">
            <h2 className="lobby-heading">Checking your sign-in…</h2>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lobby">
      <div className="lobby-shell">
        <aside className="lobby-brand">
          <div className="brand-top">
            {/* Dropped in at public/lyn-logo-cross.png. If it is not there yet
                the mark is left out rather than showing a broken image. */}
            {logoOk ? (
              <img
                className="brand-mark"
                src="/lyn-logo-cross.png"
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

          {me ? (
            <div className="signed-in-as">
              <span className="signed-in-name">{me.name}</span>
              <span className="signed-in-role">{ROLE_LABELS[me.role] || "Student"}</span>
              <span className="signed-in-email">{me.email}</span>
              <button type="button" className="link-btn" onClick={logout}>
                Not you?
              </button>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="mid">Class ID</label>
            {/* A meeting is a ClassSchedule.ScheduleID, so this is normally
                filled in by the link from lynindia.in and nobody types it. It
                stays editable for staff joining a class they were told about
                by number. Upper casing is kept for the ad-hoc room names still
                used in testing, where the room key is the raw string. */}
            <input
              id="mid"
              value={meetingId}
              onChange={(e) => setMeetingId(e.target.value.toUpperCase())}
              inputMode="numeric"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. 10214"
              required
            />
            {invited && meetingId === invited ? (
              <p className="field-note">Class filled in from your link.</p>
            ) : null}
          </div>

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Joining…" : "Join meeting"}
          </button>
        </form>
      </div>
    </div>
  );
}
