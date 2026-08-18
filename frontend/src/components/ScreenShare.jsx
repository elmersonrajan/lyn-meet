import React, { useEffect, useRef } from "react";

export default function ScreenShare({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    try {
      if (ref.current) ref.current.srcObject = stream || null;
    } catch (err) {
      console.error("[ScreenShare] attach failed", err);
    }
  }, [stream]);
  return <video className="screen" ref={ref} autoPlay playsInline />;
}
