import { useRef } from "react";

function pickMime() {
  try {
    const types = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
      "audio/webm",
    ];
    for (const t of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
  } catch (err) {
    console.error("[LocalRec] pickMime failed", err);
  }
  return "video/webm";
}

function whiteboardStream(canvas) {
  try {
    if (!canvas) return null;
    const w = canvas.width || 1280;
    const h = canvas.height || 720;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    const draw = () => {
      try {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0, w, h);
      } catch (err) {
        console.error("[LocalRec] whiteboard frame failed", err);
      }
    };
    draw();
    const timer = setInterval(draw, 80);
    const stream = off.captureStream(12);
    stream._stopBoard = () => clearInterval(timer);
    console.log("[LocalRec] whiteboard captureStream", { w, h });
    return stream;
  } catch (err) {
    console.error("[LocalRec] whiteboardStream failed", err);
    return null;
  }
}

async function sendChunk({ blob, meetingId, recorderId, isFinal }) {
  try {
    if (!blob || !blob.size) {
      if (!isFinal) return;
    }
    console.log("[LocalRec] upload chunk", {
      bytes: blob?.size || 0,
      meetingId,
      recorderId,
      isFinal,
    });
    const res = await fetch("/api/recordings/chunk", {
      method: "POST",
      headers: {
        "Content-Type": blob?.type || "video/webm",
        "X-Meeting-Id": meetingId || "1",
        "X-Recorder-Id": recorderId || "",
        "X-Final": isFinal ? "1" : "0",
      },
      body: blob && blob.size ? blob : new Uint8Array(),
    });
    const json = await res.json();
    console.log("[LocalRec] chunk ack", json);
    return json;
  } catch (err) {
    console.error("[LocalRec] sendChunk failed (will retry next slice)", err);
    return null;
  }
}

export function useLocalRecorder() {
  const recRef = useRef(null);
  const extraStopRef = useRef([]);
  const idsRef = useRef({ meetingId: "1", recorderId: "" });
  const uploadingRef = useRef(Promise.resolve());

  async function start({ localStream, screenStream, canvas, micOn, meetingId, recorderId }) {
    try {
      extraStopRef.current.forEach((fn) => {
        try { fn(); } catch (e) { console.error("[LocalRec] extra stop", e); }
      });
      extraStopRef.current = [];
      idsRef.current = { meetingId, recorderId };

      const tracks = [];
      const screenTrack = screenStream?.getVideoTracks?.()?.find((t) => t.readyState === "live");
      const camTrack = localStream?.getVideoTracks?.()?.find((t) => t.readyState === "live" && t.enabled);
      const micTrack = localStream?.getAudioTracks?.()?.find((t) => t.readyState === "live");

      if (screenTrack) {
        tracks.push(screenTrack);
        console.log("[LocalRec] using SCREEN video");
      } else if (camTrack) {
        tracks.push(camTrack);
        console.log("[LocalRec] using CAMERA video");
      } else {
        const board = whiteboardStream(canvas);
        const vt = board?.getVideoTracks?.()?.[0];
        if (vt) {
          tracks.push(vt);
          extraStopRef.current.push(() => {
            try { board._stopBoard?.(); vt.stop(); } catch (e) { console.error(e); }
          });
          console.log("[LocalRec] NO cam/screen — recording WHITEBOARD");
        } else {
          console.warn("[LocalRec] NO video at all");
        }
      }

      if (micOn && micTrack) {
        tracks.push(micTrack);
        console.log("[LocalRec] using MIC audio");
      } else {
        console.warn("[LocalRec] NO audio");
      }

      if (!tracks.length) {
        console.warn("[LocalRec] nothing to record — logs only");
        return { mode: "logs-only" };
      }

      const mixed = new MediaStream(tracks);
      const mime = pickMime();
      console.log("[LocalRec] MediaRecorder start, upload every 3s", { mime, meetingId, recorderId });
      const rec = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
      rec.ondataavailable = (ev) => {
        try {
          if (!ev.data || !ev.data.size) return;
          uploadingRef.current = uploadingRef.current.then(() =>
            sendChunk({
              blob: ev.data,
              meetingId: idsRef.current.meetingId,
              recorderId: idsRef.current.recorderId,
              isFinal: false,
            }),
          );
        } catch (err) {
          console.error("[LocalRec] dataavailable failed", err);
        }
      };
      rec.onerror = (ev) => console.error("[LocalRec] MediaRecorder error", ev);
      rec.start(3000);
      recRef.current = rec;
      return { mode: "recording", mime };
    } catch (err) {
      console.error("[LocalRec] start failed", err);
      throw err;
    }
  }

  function stop() {
    return new Promise((resolve) => {
      try {
        const rec = recRef.current;
        if (!rec || rec.state === "inactive") {
          extraStopRef.current.forEach((fn) => { try { fn(); } catch (e) {} });
          extraStopRef.current = [];
          sendChunk({
            blob: null,
            meetingId: idsRef.current.meetingId,
            recorderId: idsRef.current.recorderId,
            isFinal: true,
          }).finally(() => resolve(null));
          return;
        }
        rec.onstop = async () => {
          try {
            extraStopRef.current.forEach((fn) => { try { fn(); } catch (e) {} });
            extraStopRef.current = [];
            await uploadingRef.current;
            await sendChunk({
              blob: null,
              meetingId: idsRef.current.meetingId,
              recorderId: idsRef.current.recorderId,
              isFinal: true,
            });
            recRef.current = null;
            console.log("[LocalRec] stopped + finalized on server");
            resolve(true);
          } catch (err) {
            console.error("[LocalRec] onstop failed", err);
            resolve(null);
          }
        };
        rec.stop();
      } catch (err) {
        console.error("[LocalRec] stop failed", err);
        resolve(null);
      }
    });
  }

  return { start, stop };
}
