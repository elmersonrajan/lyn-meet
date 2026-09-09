/**
 * What each student is actually sent, and what happens when they cannot carry
 * even the smallest version of it.
 *
 * The camera arrives as a ladder of three sizes (see config/media.js) and
 * mediasoup already moves a student up and down it on its own, from its own
 * bandwidth estimate. That covers "slow" and it needs no help.
 *
 * What it does not cover is "too slow for the bottom rung". There, mediasoup
 * simply sends nothing and the student sits looking at a frozen tile with no
 * idea whether the class is still running -- while their connection goes on
 * being spent trying. This module notices that state and takes the picture
 * away deliberately, leaving the audio, which is the part of a lesson that
 * cannot be done without. It offers the picture back a little later in case
 * the line recovered.
 *
 * There is a manual choice too, because a student paying for their own data
 * may want the small picture even on a connection that could carry more, and
 * because an automatic decision a person cannot override is a worse decision.
 */
const { createLogger } = require("../utils/logger");

const log = createLogger("VideoQuality");

const MODES = ["auto", "low", "audio-only"];

/** Anything unrecognised is `auto`; this is fed straight from a client. */
function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : "auto";
}

/**
 * The ceiling to put on a consumer for a given mode.
 *
 * mediasoup treats preferred layers as a maximum, not a demand, so `auto` is
 * the top of the ladder rather than a special case -- it lets the estimate
 * pick anything up to the best rung, which is the behaviour we want.
 *
 * @returns {{spatialLayer:number, temporalLayer:number}|null} null when the
 *   mode is not about layers at all
 */
function preferredLayersFor(mode, topLayer) {
  const top = Math.max(0, Number(topLayer) || 0);
  if (mode === "low") return { spatialLayer: 0, temporalLayer: 1 };
  if (mode === "audio-only") return null;
  return { spatialLayer: top, temporalLayer: 2 };
}

/**
 * Whether a consumer reporting no layers is a connection problem.
 *
 * It is not, when the teacher simply turned their camera off: the producer is
 * paused, nothing is being sent to anybody, and every student in the room
 * would otherwise be told at once that their internet had failed.
 */
function isStarved(consumer) {
  return Boolean(consumer) && consumer.kind === "video" && !consumer.producerPaused;
}

/**
 * The decision, as a pure function, so it can be tested without a room.
 *
 * @param {{starvedSince:number|null, suspended:boolean, suspendedAt:number|null}} state
 * @param {{autoAudioAfterMs:number, retryVideoAfterMs:number}} config
 * @param {number} now
 * @returns {"suspend"|"retry"|"wait"}
 */
function decide(state, config, now) {
  if (state.suspended) {
    const waited = now - (state.suspendedAt || 0);
    return config.retryVideoAfterMs > 0 && waited >= config.retryVideoAfterMs ? "retry" : "wait";
  }
  if (!state.starvedSince) return "wait";
  if (!(config.autoAudioAfterMs > 0)) return "wait";
  return now - state.starvedSince >= config.autoAudioAfterMs ? "suspend" : "wait";
}

/**
 * Per-peer state. Kept here rather than on the Peer so that a room with this
 * module switched off carries nothing extra.
 */
function stateOf(peer) {
  if (!peer._videoQuality) {
    peer._videoQuality = {
      mode: "auto",
      starvedSince: null,
      suspended: false,
      suspendedAt: null,
      timer: null,
    };
  }
  return peer._videoQuality;
}

function videoConsumers(peer) {
  return [...peer.consumers.values()].filter((c) => c.kind === "video");
}

async function applyToConsumer(consumer, mode, topLayer) {
  try {
    if (mode === "audio-only") {
      if (!consumer.paused) await consumer.pause();
      return;
    }
    if (consumer.paused) await consumer.resume();
    if (consumer.type !== "simulcast" && consumer.type !== "svc") return;
    const layers = preferredLayersFor(mode, topLayer);
    if (layers) await consumer.setPreferredLayers(layers);
  } catch (err) {
    // A consumer that closed underneath us, most likely. The next one created
    // gets the mode applied at birth, so there is nothing to repair.
    log.warn("could not apply video quality to a consumer", { mode, error: err.message });
  }
}

/**
 * The whole of what the socket layer needs.
 *
 * `emit` is passed in rather than the io server, so this module knows nothing
 * about transports and can be exercised with a plain function in a test.
 */
function createController({ emit, profile }) {
  const quality = profile?.quality || {};
  const config = {
    autoAudioAfterMs: Number(quality.autoAudioAfterMs) || 0,
    retryVideoAfterMs: Number(quality.retryVideoAfterMs) || 0,
  };
  const topLayer = Math.max(0, (profile?.camera?.layers?.length || 1) - 1);

  async function setMode(peer, requested) {
    const state = stateOf(peer);
    const mode = normalizeMode(requested);
    state.mode = mode;
    // A person choosing for themselves ends the automatic story: they are not
    // "suspended by the server" any more, they are simply on the mode they
    // picked, and the retry timer must not undo it.
    state.suspended = false;
    state.suspendedAt = null;
    state.starvedSince = null;
    for (const consumer of videoConsumers(peer)) {
      await applyToConsumer(consumer, mode, topLayer);
    }
    log.action("video quality set", { peerId: peer.id, mode });
    emit(peer, "video-quality", { mode, automatic: false });
    return mode;
  }

  /** Called for every new video consumer, so a mode outlives the tile it was set on. */
  async function onConsumerCreated(peer, consumer) {
    const state = stateOf(peer);
    const effective = state.suspended ? "audio-only" : state.mode;
    await applyToConsumer(consumer, effective, topLayer);
    if (consumer.kind !== "video") return;

    consumer.on("layerschange", (layers) => {
      try {
        onLayers(peer, consumer, layers);
      } catch (err) {
        log.error("layerschange handling failed", err);
      }
    });
  }

  function onLayers(peer, consumer, layers) {
    const state = stateOf(peer);
    // A person who chose their own mode is left alone.
    if (state.mode !== "auto") return;

    if (layers) {
      state.starvedSince = null;
      emit(peer, "stream-quality", {
        producerId: consumer.producerId,
        spatialLayer: layers.spatialLayer,
        temporalLayer: layers.temporalLayer,
        top: topLayer,
      });
      return;
    }

    if (!isStarved(consumer)) return;
    if (!state.starvedSince) state.starvedSince = Date.now();
    emit(peer, "stream-quality", { producerId: consumer.producerId, spatialLayer: null, top: topLayer });
    schedule(peer);
  }

  function schedule(peer) {
    const state = stateOf(peer);
    if (state.timer) return;
    const delay = state.suspended ? config.retryVideoAfterMs : config.autoAudioAfterMs;
    if (!(delay > 0)) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      tick(peer).catch((err) => log.error("video quality tick failed", err));
    }, delay);
    // Never a reason to hold the process open.
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  async function tick(peer) {
    const state = stateOf(peer);
    if (peer.disconnected || state.mode !== "auto") return;
    const action = decide(state, config, Date.now());

    if (action === "suspend") {
      state.suspended = true;
      state.suspendedAt = Date.now();
      for (const consumer of videoConsumers(peer)) {
        await applyToConsumer(consumer, "audio-only", topLayer);
      }
      log.warn("student dropped to audio — their connection could not carry the smallest picture", {
        peerId: peer.id,
        name: peer.name,
      });
      emit(peer, "video-quality", { mode: "audio-only", automatic: true });
      schedule(peer);
      return;
    }

    if (action === "retry") {
      state.suspended = false;
      state.suspendedAt = null;
      state.starvedSince = null;
      for (const consumer of videoConsumers(peer)) {
        await applyToConsumer(consumer, "auto", topLayer);
      }
      log.info("offering the picture back to see whether the line recovered", { peerId: peer.id });
      emit(peer, "video-quality", { mode: "auto", automatic: true });
      return;
    }

    // Still counting down, or nothing to do. Keep the clock running only while
    // the starvation is still true.
    if (state.starvedSince || state.suspended) schedule(peer);
  }

  function forget(peer) {
    const state = peer?._videoQuality;
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = null;
  }

  return { setMode, onConsumerCreated, forget, modeOf: (peer) => stateOf(peer).mode };
}

module.exports = {
  MODES,
  normalizeMode,
  preferredLayersFor,
  isStarved,
  decide,
  createController,
};
