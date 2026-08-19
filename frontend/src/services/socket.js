import { io } from "socket.io-client";

const SOCKET_URL = window.location.origin;

let socket = null;

export function getSocket() {
  try {
    if (socket && socket.connected) return socket;
    if (socket) return socket;

    console.log("[Socket] creating client", { url: SOCKET_URL });
    socket = io(SOCKET_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 12,
      reconnectionDelay: 800,
    });

    socket.on("connect", () => console.log("[Socket] connected", socket.id));
    socket.on("disconnect", (reason) => console.warn("[Socket] disconnected", reason));
    socket.on("connect_error", (err) => console.error("[Socket] connect_error", err));
    return socket;
  } catch (err) {
    console.error("[Socket] getSocket failed", err);
    throw err;
  }
}

export function emitAck(event, payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      const s = getSocket();
      console.log(`[Socket] emit ${event}`, payload);
      s.emit(event, payload, (res) => {
        console.log(`[Socket] ack ${event}`, res);
        if (!res || res.ok === false) {
          reject(new Error(res?.error || `${event} failed`));
          return;
        }
        resolve(res);
      });
    } catch (err) {
      console.error(`[Socket] emitAck ${event} failed`, err);
      reject(err);
    }
  });
}