import React, { useEffect, useRef } from "react";

function AudioSink({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    try {
      const el = ref.current;
      if (!el) return;
      el.srcObject = stream;
      const play = () => el.play().catch((err) => console.warn("[RemoteAudio] play blocked", err));
      play();
    } catch (err) {
      console.error("[RemoteAudio] attach failed", err);
    }
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

export default function RemoteAudio({ items = [] }) {
  return (
    <div aria-hidden style={{ display: "none" }}>
      {items.map((item) => (
        <AudioSink key={item.id} stream={item.stream} />
      ))}
    </div>
  );
}
