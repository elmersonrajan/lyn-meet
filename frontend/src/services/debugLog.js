import { getSocket } from "./socket";

const queue = [];

function safe(v) {
  try {
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (typeof v === "undefined") return null;
    return JSON.parse(JSON.stringify(v));
  } catch (err) {
    try {
      return String(v);
    } catch (e) {
      return "[unserializable]";
    }
  }
}

function flush(s) {
  try {
    while (queue.length && s.connected) {
      s.emit("client-log", queue.shift());
    }
  } catch (err) {
    /* ignore */
  }
}

export function installClientLogTee() {
  try {
    const s = getSocket();
    s.on("connect", () => flush(s));

    ["log", "warn", "error", "info", "debug"].forEach((level) => {
      const orig = console[level] ? console[level].bind(console) : console.log.bind(console);
      console[level] = (...args) => {
        try {
          orig(...args);
        } catch (e) {
          /* ignore */
        }
        try {
          const row = {
            t: new Date().toISOString(),
            level,
            href: typeof window !== "undefined" ? window.location.href : "",
            args: args.map(safe),
          };
          if (s.connected) s.emit("client-log", row);
          else {
            queue.push(row);
            if (queue.length > 2000) queue.shift();
          }
        } catch (e) {
          /* ignore */
        }
      };
    });
    console.log("[ClientLog] tee on — browser logs go to backend/logs/last-meeting.log");
  } catch (err) {
    console.error("[ClientLog] install failed", err);
  }
}
