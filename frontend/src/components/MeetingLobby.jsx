import React, { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "../context/UserContext.jsx";
import { getSocket, emitAck } from "../services/socket.js";
import { readMeetingIdFromUrl } from "../services/meetingLink.js";
import { fetchMe, goToLogin, logout, redeemHandoffToken } from "../services/auth.js";

/**
 * Auto-join fires once per page load, not once per mount.
 *
 * Leaving a meeting unmounts the room and mounts this lobby again, with the
 * class still in the URL and the cookie still valid -- so a ref inside the
 * component would reset and pull the person straight back into the meeting
 * they just left. That made Leave and End Session look broken: both worked,
 * and both were undone within the same tick.
 *
 * Module scope survives the remount and still resets on a real page load,
 * which is exactly the boundary wanted: arriving from a link joins, leaving
 * stays left.
 */
let autoJoinSpent = false;

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
  // True while going straight into a class from a link, so the form is never
  // rendered for the people who never needed it.
  const [autoJoining, setAutoJoining] = useState(false);
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
        // has to be redeemed on this page load or it is wasted.
        let user = null;
        try {
          user = await redeemHandoffToken();
        } catch (err) {
          if (cancelled) return;
          // A refused *account* is final and the reason is shown. A spent or
          // stale token is not: the session cookie lasts eight hours, and
          // someone who leaves a class and comes back through the same link
          // still holds one. Bouncing them to lynindia.in for a fresh token
          // was how "leave, then rejoin" became impossible -- the site handed
          // back the same spent link and the loop never broke.
          if (!err.recoverable) throw err;
          console.warn("[Lobby] hand-off token spent — falling back to the session");
        }
        if (cancelled) return;

        if (!user) user = await fetchMe();
        if (cancelled) return;
        if (!user) {
          // No token and no session: genuinely signed out.
          goToLogin();
          return;
        }
        setMe(user);
        setSession((s) => ({ ...s, name: user.name, role: user.role, email: user.email }));
      } catch (err) {
        if (cancelled) return;
        setError(err.message || "Could not verify your sign-in");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession]);

  const enterMeeting = useCallback(async (id) => {
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
      const res = await emitAck("join-room", { meetingId: id });
      setSession({
        name: res.peer?.name || me.name,
        email: me.email,
        meetingId: id,
        role: res.peer?.role || me.role,
        peer: res.peer,
        joined: true,
      });
      onJoinPayload(res);
      onJoined();
    } catch (err) {
      console.error("[Lobby] join failed", err);
      setError(err.message || "Failed to join meeting");
      // Dropping back to the form is the point: the server's reason -- not
      // enrolled, no such class, cancelled -- has to be readable, and staff
      // may want to try a different class number.
      setAutoJoining(false);
    } finally {
      setBusy(false);
    }
  }, [me, onJoinPayload, onJoined, setSession]);

  const join = (e) => {
    e.preventDefault();
    enterMeeting(meetingId);
  };

  /**
   * Arriving from lynindia.in goes straight into the class.
   *
   * The link already carries both facts a join needs -- who you are, and which
   * lesson -- so stopping to show a form with your own name in it and one
   * button is a step that asks nothing. Someone who opens the site without a
   * class in the link still gets the form, because there is nothing to join.
   *
   * The ref guards against React running effects twice in development, which
   * would otherwise fire two joins for one arrival.
   */
  const autoTried = useRef(false);
  useEffect(() => {
    if (!me || !invited || !meetingId) return;
    if (autoTried.current || autoJoinSpent) return;
    autoTried.current = true;
    autoJoinSpent = true;
    setAutoJoining(true);
    enterMeeting(meetingId);
  }, [me, invited, meetingId, enterMeeting]);

  if (checking || (autoJoining && !error)) {
    return (
      <div className="lobby">
        <div className="lobby-shell">
          <div className="lobby-card">
            <h2 className="lobby-heading">
              {checking ? "Checking your sign-in…" : "Joining your class…"}
            </h2>
            {me && autoJoining ? (
              <p className="lead">
                {me.name} · {ROLE_LABELS[me.role] || "Student"}
              </p>
            ) : null}
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
