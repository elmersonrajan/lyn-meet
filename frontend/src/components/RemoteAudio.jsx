import React, { useEffect, useRef, useState } from "react";

function AudioSink({ stream }) {
  const ref = useRef(null);

  useEffect(() => {
    try {
      const el = ref.current;
      if (!el) return undefined;
      el.srcObject = stream || null;
      el.muted = false;
      el.volume = 1;
      const play = () => {
        el.play().catch((err) => console.warn("[RemoteAudio] play blocked", err));
      };
      play();
      const unlock = () => play();
      window.addEventListener("pointerdown", unlock);
      return () => window.removeEventListener("pointerdown", unlock);
    } catch (err) {
      console.error("[RemoteAudio] attach failed", err);
    }
    return undefined;
  }, [stream]);

  return (
    <audio
      ref={ref}
      autoPlay
      playsInline
      controls={false}
      style={{ width: 0, height: 0, position: "absolute", opacity: 0, pointerEvents: "none" }}
    />
  );
}

export default function RemoteAudio({ items = [] }) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    setBlocked(items.length > 0);
    const t = setTimeout(() => setBlocked(false), 4000);
    return () => clearTimeout(t);
  }, [items.length]);

  const unlockAll = () => {
    try {
      document.querySelectorAll("audio").forEach((el) => {
        el.muted = false;
        el.volume = 1;
        el.play().catch((err) => console.warn("[RemoteAudio] unlock play", err));
      });
      setBlocked(false);
      console.log("[RemoteAudio] unlocked", items.length);
    } catch (err) {
      console.error("[RemoteAudio] unlock failed", err);
    }
  };

  return (
    <>
      <div className="remote-audio-sinks" aria-label="Class audio">
        {items.map((item) => (
          <AudioSink key={item.id} stream={item.stream} />
        ))}
      </div>
      {blocked && items.length > 0 ? (
        <button type="button" className="hear-class-btn" onClick={unlockAll}>
          Tap to hear class audio
        </button>
      ) : null}
    </>
  );
}
