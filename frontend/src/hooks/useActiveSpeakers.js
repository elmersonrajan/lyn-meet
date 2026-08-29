import { useEffect, useRef, useState } from "react";

/**
 * Who is currently talking, as a list of peer ids.
 *
 * The server re-judges the room several times a second, but speech is not
 * continuous: the gap between two words, or between two sentences, is silence,
 * and following the raw signal would make the indicator strobe. So a speaker
 * stays lit for a short while after they were last heard, and only goes out if
 * they stay quiet — the same reason the indicator in any conferencing app looks
 * steady while someone is mid-sentence.
 */
const HOLD_MS = 1200;
const SWEEP_MS = 300;

export function useActiveSpeakers(socket) {
  const [speaking, setSpeaking] = useState([]);
  // peerId -> the moment they stop counting as speaking.
  const untilRef = useRef(new Map());

  useEffect(() => {
    if (!socket) return undefined;

    // Only re-render when the set actually changes, not on every sweep: this
    // list sits above the participant list and would otherwise rebuild it
    // three times a second for nothing.
    const publish = () => {
      const now = Date.now();
      const live = [];
      for (const [id, until] of untilRef.current) {
        if (until > now) live.push(id);
        else untilRef.current.delete(id);
      }
      setSpeaking((prev) =>
        prev.length === live.length && prev.every((id, i) => id === live[i]) ? prev : live,
      );
    };

    const onSpeakers = ({ speakers }) => {
      const now = Date.now();
      // Kept in the order the server sent, which is loudest first.
      for (const id of speakers || []) untilRef.current.set(id, now + HOLD_MS);
      publish();
    };

    socket.on("active-speakers", onSpeakers);
    const sweep = setInterval(publish, SWEEP_MS);

    return () => {
      socket.off("active-speakers", onSpeakers);
      clearInterval(sweep);
      untilRef.current.clear();
    };
  }, [socket]);

  return speaking;
}
