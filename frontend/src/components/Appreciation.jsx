import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Praise, across everybody's screen at once.
 *
 * A class online loses the things that make praise land in a room -- forty
 * faces turning, a bit of applause. This is the substitute: when the teacher
 * marks a good answer, every screen in the meeting stops for a moment and says
 * so, so the student being praised is praised in front of the class rather than
 * in a line of chat nobody was reading.
 *
 * It clears itself. Nothing a teacher has to dismiss mid-lesson belongs on top
 * of the whole meeting.
 */
const VISIBLE_MS = 4200;
const CONFETTI_COUNT = 28;
const COLOURS = ["#f5c518", "#2f9e6b", "#2d6cdf", "#e0563f", "#8b5cf6", "#0fa3a3"];

export default function Appreciation({ award, onDone }) {
  const [leaving, setLeaving] = useState(false);

  /**
   * Fixed per award, not per render: recomputing on a parent re-render would
   * restart every piece of confetti halfway down the screen.
   */
  const confetti = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 900,
        duration: 2400 + Math.random() * 1800,
        drift: Math.random() * 60 - 30,
        colour: COLOURS[i % COLOURS.length],
        tilt: Math.random() * 360,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [award?.at],
  );

  /**
   * Held in a ref so the timers below depend on the award alone.
   *
   * The parent hands this in as a new function on every render, and a meeting
   * re-renders constantly -- somebody joins, a hand goes up, a poll count
   * changes. Depending on it directly would restart the countdown each time and
   * the celebration would sit on top of the lesson indefinitely.
   */
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!award) return undefined;
    setLeaving(false);
    // Fades before it goes, so the meeting comes back rather than snapping back.
    const fade = setTimeout(() => setLeaving(true), VISIBLE_MS - 600);
    const done = setTimeout(() => doneRef.current?.(), VISIBLE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [award]);

  if (!award) return null;

  return (
    <div className={`celebrate ${leaving ? "leaving" : ""}`} role="status" aria-live="polite">
      <div className="celebrate-confetti" aria-hidden="true">
        {confetti.map((c) => (
          <span
            key={c.id}
            className="confetti"
            style={{
              left: `${c.left}%`,
              background: c.colour,
              animationDelay: `${c.delay}ms`,
              animationDuration: `${c.duration}ms`,
              // Two custom properties the keyframes read, so each piece falls
              // its own way instead of the whole lot moving as a block.
              "--drift": `${c.drift}px`,
              "--tilt": `${c.tilt}deg`,
            }}
          />
        ))}
      </div>
      <div className="celebrate-card">
        <div className="celebrate-emoji">{award.emoji}</div>
        <div className="celebrate-message">
          {award.emoji} {award.message} {award.emoji}
        </div>
        {award.by ? <div className="celebrate-by">from {award.by}</div> : null}
      </div>
    </div>
  );
}
