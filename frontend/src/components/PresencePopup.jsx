import React, { useEffect, useRef } from "react";

/**
 * Somebody left the meeting.
 *
 * A student disappearing from the list is easy to miss while teaching, and it
 * is the one piece of presence a teacher actually needs: a class of thirty that
 * quietly becomes a class of twelve is worth noticing at the time rather than
 * from the register afterwards.
 *
 * Five seconds, then gone on its own. Long enough to read a name mid-sentence,
 * short enough that four in a row do not become a wall.
 */
const VISIBLE_MS = 5000;

export default function PresencePopup({ events, onExpire }) {
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    if (!events.length) return undefined;
    // One timer per event rather than one for the list: each has its own five
    // seconds, so a second departure does not shorten the first's stay.
    const timers = events.map((event) =>
      setTimeout(() => expireRef.current?.(event.id), Math.max(0, event.at + VISIBLE_MS - Date.now())),
    );
    return () => timers.forEach(clearTimeout);
  }, [events]);

  if (!events.length) return null;

  return (
    <div className="presence-stack" role="status" aria-live="polite">
      {events.map((event) => (
        <div key={event.id} className="presence-pop">
          <span className="presence-dot" aria-hidden="true" />
          <span className="presence-name">{event.name}</span>
          <span className="presence-what">{event.what}</span>
        </div>
      ))}
    </div>
  );
}
