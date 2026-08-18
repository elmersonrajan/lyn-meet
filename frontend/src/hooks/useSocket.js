import { useEffect, useState } from "react";
import { getSocket } from "../services/socket";

export function useSocket() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let s;
    try {
      s = getSocket();
      const onConnect = () => {
        console.log("[useSocket] connected");
        setConnected(true);
      };
      const onDisconnect = () => {
        console.warn("[useSocket] disconnected");
        setConnected(false);
      };
      s.on("connect", onConnect);
      s.on("disconnect", onDisconnect);
      if (!s.connected) s.connect();
      setConnected(s.connected);
      return () => {
        try {
          s.off("connect", onConnect);
          s.off("disconnect", onDisconnect);
        } catch (err) {
          console.error("[useSocket] cleanup failed", err);
        }
      };
    } catch (err) {
      console.error("[useSocket] setup failed", err);
    }
  }, []);

  return { socket: getSocket(), connected };
}
