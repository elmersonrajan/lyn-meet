/**
 * How much data a class is allowed to cost, and how it is allowed to vary.
 *
 * The camera used to be sent as one stream at one size, which forces a single
 * compromise on everybody: small enough for the worst connection in the room
 * means blurry for everyone else, and blurry in the recording too.
 *
 * So it is sent as three at once -- a ladder -- and the server hands each
 * student whichever rung their connection can actually carry, switching as it
 * changes. This is what Meet and Zoom do, and mediasoup does the switching
 * itself once the ladder exists. Nothing here has to decide it per student.
 *
 *   rung 0   320x180    ~150 kbps   a bad phone line
 *   rung 1   640x360    ~500 kbps   the ordinary case
 *   rung 2  1280x720   ~1500 kbps   a good connection, and the recording
 *
 * The teacher's browser sends all three, so their uplink carries roughly the
 * sum -- about 2.2 Mbps at full tilt. It costs the teacher more than the
 * single small stream did. That is the trade for a sharp recording and a sharp
 * picture for students who have the bandwidth for one, and the browser drops
 * the upper rungs by itself when the teacher's own connection cannot keep up.
 *
 * A screen share stays a single stream: it is already sent at its own
 * resolution because text has to stay legible, and there is no smaller version
 * of a spreadsheet worth sending.
 *
 * The profile lives here, on the server, and is handed to each browser when it
 * joins -- so it can be tuned from a `.env` file and a restart rather than a
 * frontend rebuild.
 */
const number = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

const flag = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
};

/**
 * The rungs, lowest first.
 *
 * Lowest first is not cosmetic: WebRTC matches this array to the encoder's
 * layers in order, and a ladder given the other way round produces a top rung
 * that is the smallest picture.
 *
 * `scale` divides the captured size, so it depends on `camera.width`: at a
 * 1280-wide capture, 4 is 320 and 1 is 1280.
 */
function cameraLayers() {
  if (!flag("CAM_SIMULCAST", true)) return null;
  return [
    { id: "low", scale: 4, maxBitrate: number("CAM_LOW_BITRATE", 150000) },
    { id: "mid", scale: 2, maxBitrate: number("CAM_MID_BITRATE", 500000) },
    { id: "high", scale: 1, maxBitrate: number("CAM_HIGH_BITRATE", 1500000) },
  ];
}

function mediaProfile() {
  const layers = cameraLayers();
  return {
    camera: {
      /**
       * Captured at the size of the TOP rung, because every rung below is
       * produced by scaling this down. Capturing at 640 and asking for a
       * 1280 rung gets 640 stretched, which is worse than not offering it.
       */
      width: number("CAM_WIDTH", 1280),
      height: number("CAM_HEIGHT", 720),
      frameRate: number("CAM_FPS", 24),
      /** The ladder, or null when simulcast is switched off. */
      layers,
      /**
       * Only used when there is no ladder. Kept so `CAM_SIMULCAST=0` is a
       * complete fallback to the old single-stream behaviour rather than a
       * half-configured one.
       */
      maxBitrate: number("CAM_MAX_BITRATE", 600000),
      /**
       * A talking head that stutters reads as a broken connection, while one
       * that softens for a moment reads as nothing at all. Under pressure the
       * encoder gives up sharpness rather than smoothness.
       */
      degradationPreference: process.env.CAM_DEGRADATION || "maintain-framerate",
    },
    screen: {
      maxBitrate: number("SCREEN_MAX_BITRATE", 1200000),
      maxFramerate: number("SCREEN_MAX_FPS", 24),
    },
    /**
     * What a student on a poor line is allowed to do about it.
     *
     * `auto` is mediasoup choosing a rung for them, which is the right answer
     * almost always. The other two exist because a student who is paying for
     * their own data, or on a line so bad that even the bottom rung stalls,
     * needs a way to say so that does not involve leaving the class.
     */
    quality: {
      modes: ["auto", "low", "audio-only"],
      /**
       * Drop a student to audio when their connection has been unable to carry
       * even the bottom rung for this long. Zero switches the automatic part
       * off and leaves only the manual choice.
       */
      autoAudioAfterMs: number("LOW_BANDWIDTH_AUDIO_AFTER_MS", 12000),
      /** How long before offering the picture back, to see if it recovered. */
      retryVideoAfterMs: number("LOW_BANDWIDTH_RETRY_MS", 45000),
    },
    /**
     * A ceiling on everything one person sends, enforced by the server rather
     * than requested of the browser. It has to fit the whole camera ladder and
     * a screen share at once, with room for audio.
     */
    maxIncomingBitrate: number("MAX_INCOMING_BITRATE", 3800000),
  };
}

/**
 * The rung the recording should be given.
 *
 * The recorder consumes over a plain transport with no congestion control, so
 * mediasoup has nothing to estimate and will not raise it off the bottom rung
 * by itself. Left alone, an hour of class is recorded at 320x180 and then
 * scaled up to 720p for the file -- which is exactly the blurry recording this
 * ladder exists to fix. So it is asked for the top rung explicitly.
 */
function recordingSpatialLayer() {
  const layers = cameraLayers();
  const top = layers ? layers.length - 1 : 0;
  const raw = Number(process.env.RECORDING_SPATIAL_LAYER);
  return Number.isInteger(raw) && raw >= 0 ? Math.min(raw, top) : top;
}

module.exports = { mediaProfile, cameraLayers, recordingSpatialLayer };
