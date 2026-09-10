const test = require("node:test");
const assert = require("node:assert");

const {
  MODES,
  normalizeMode,
  preferredLayersFor,
  isStarved,
  decide,
  createController,
} = require("../src/mediasoup/videoQuality");
const { mediaProfile, cameraLayers, recordingSpatialLayer } = require("../src/config/media");

const CONFIG = { autoAudioAfterMs: 12000, retryVideoAfterMs: 45000 };

test("the ladder goes small to large, which is the order WebRTC pairs it in", () => {
  const layers = cameraLayers();
  assert.strictEqual(layers.length, 3);
  // Reversed, the "top" rung would be the smallest picture and the recording
  // would be sharpest at 320 wide.
  const scales = layers.map((l) => l.scale);
  assert.deepStrictEqual(scales, [4, 2, 1]);
  const rates = layers.map((l) => l.maxBitrate);
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2], rates.join(","));
});

test("the capture is the size of the top rung, or the top rung is a stretch", () => {
  const cam = mediaProfile().camera;
  const top = cam.layers[cam.layers.length - 1];
  assert.strictEqual(top.scale, 1);
  assert.strictEqual(cam.width, 1280);
  assert.strictEqual(cam.height, 720);
});

test("the recording asks for the top rung", () => {
  assert.strictEqual(recordingSpatialLayer(), cameraLayers().length - 1);
});

test("a mode from a client is never trusted", () => {
  assert.strictEqual(normalizeMode("auto"), "auto");
  assert.strictEqual(normalizeMode("low"), "low");
  assert.strictEqual(normalizeMode("audio-only"), "audio-only");
  assert.strictEqual(normalizeMode("HD"), "auto");
  assert.strictEqual(normalizeMode(undefined), "auto");
  assert.strictEqual(normalizeMode({ spatialLayer: 9 }), "auto");
  assert.deepStrictEqual(MODES, ["auto", "low", "audio-only"]);
});

test("auto is the top of the ladder, not a special case", () => {
  // mediasoup treats preferred layers as a ceiling, so "auto" is "you may go
  // all the way up" and the estimate still decides.
  assert.deepStrictEqual(preferredLayersFor("auto", 2), { spatialLayer: 2, temporalLayer: 2 });
  assert.deepStrictEqual(preferredLayersFor("low", 2), { spatialLayer: 0, temporalLayer: 1 });
  assert.strictEqual(preferredLayersFor("audio-only", 2), null);
});

test("a one-rung ladder still produces a valid ceiling", () => {
  assert.deepStrictEqual(preferredLayersFor("auto", 0), { spatialLayer: 0, temporalLayer: 2 });
  assert.deepStrictEqual(preferredLayersFor("auto", undefined), { spatialLayer: 0, temporalLayer: 2 });
});

/**
 * The distinction that decides whether forty students are told their internet
 * failed the moment the teacher turns their camera off.
 */
test("a paused producer is not a bad connection", () => {
  assert.strictEqual(isStarved({ kind: "video", producerPaused: false }), true);
  assert.strictEqual(isStarved({ kind: "video", producerPaused: true }), false);
  assert.strictEqual(isStarved({ kind: "audio", producerPaused: false }), false);
  assert.strictEqual(isStarved(null), false);
});

test("nothing happens until the starvation has lasted", () => {
  const at = 1000;
  const state = { starvedSince: at, suspended: false, suspendedAt: null };
  assert.strictEqual(decide(state, CONFIG, at + 1), "wait");
  assert.strictEqual(decide(state, CONFIG, at + 11999), "wait");
  assert.strictEqual(decide(state, CONFIG, at + 12000), "suspend");
});

test("a connection that recovers before the timer is left alone", () => {
  const state = { starvedSince: null, suspended: false, suspendedAt: null };
  assert.strictEqual(decide(state, CONFIG, 999999), "wait");
});

test("the picture is offered back after the retry, and not before", () => {
  const at = 5000;
  const state = { starvedSince: null, suspended: true, suspendedAt: at };
  assert.strictEqual(decide(state, CONFIG, at + 44999), "wait");
  assert.strictEqual(decide(state, CONFIG, at + 45000), "retry");
});

test("zero switches the automatic parts off without switching the manual one off", () => {
  const off = { autoAudioAfterMs: 0, retryVideoAfterMs: 0 };
  assert.strictEqual(decide({ starvedSince: 1, suspended: false }, off, 999999), "wait");
  assert.strictEqual(decide({ starvedSince: null, suspended: true, suspendedAt: 1 }, off, 999999), "wait");
});

/* ---------- The controller, against fake consumers ---------- */

function fakeConsumer({ kind = "video", type = "simulcast" } = {}) {
  return {
    kind,
    type,
    paused: false,
    producerPaused: false,
    producerId: "p1",
    preferred: null,
    handlers: {},
    on(event, fn) {
      this.handlers[event] = fn;
    },
    async pause() {
      this.paused = true;
    },
    async resume() {
      this.paused = false;
    },
    async setPreferredLayers(layers) {
      this.preferred = layers;
    },
  };
}

function fakePeer(consumers = []) {
  return {
    id: "peer-1",
    name: "A Student",
    disconnected: false,
    consumers: new Map(consumers.map((c, i) => [`c${i}`, c])),
  };
}

function controller(sent) {
  return createController({
    profile: mediaProfile(),
    emit: (peer, event, payload) => sent.push({ event, payload }),
  });
}

test("choosing audio only pauses the video and says so", async () => {
  const sent = [];
  const consumer = fakeConsumer();
  const peer = fakePeer([consumer]);
  await controller(sent).setMode(peer, "audio-only");

  assert.strictEqual(consumer.paused, true);
  assert.deepStrictEqual(sent, [
    { event: "video-quality", payload: { mode: "audio-only", automatic: false } },
  ]);
});

test("coming back from audio only resumes the consumer", async () => {
  const sent = [];
  const consumer = fakeConsumer();
  const peer = fakePeer([consumer]);
  const ctl = controller(sent);
  await ctl.setMode(peer, "audio-only");
  await ctl.setMode(peer, "auto");

  assert.strictEqual(consumer.paused, false);
  assert.deepStrictEqual(consumer.preferred, { spatialLayer: 2, temporalLayer: 2 });
});

test("save-data pins the bottom rung", async () => {
  const consumer = fakeConsumer();
  const peer = fakePeer([consumer]);
  await controller([]).setMode(peer, "low");
  assert.deepStrictEqual(consumer.preferred, { spatialLayer: 0, temporalLayer: 1 });
});

/**
 * The case that made this necessary: a producer republishes -- the teacher
 * toggles their camera, or reconnects -- and a student on a failing line is
 * handed the full picture again at the worst possible moment.
 */
test("a new consumer inherits the mode the student is already on", async () => {
  const first = fakeConsumer();
  const peer = fakePeer([first]);
  const ctl = controller([]);
  await ctl.setMode(peer, "audio-only");

  const second = fakeConsumer();
  peer.consumers.set("c1", second);
  await ctl.onConsumerCreated(peer, second);

  assert.strictEqual(second.paused, true);
});

test("an audio consumer is never given layers or paused for quality", async () => {
  const audio = fakeConsumer({ kind: "audio", type: "simple" });
  const peer = fakePeer([audio]);
  await controller([]).setMode(peer, "low");
  assert.strictEqual(audio.preferred, null);
  assert.strictEqual(audio.paused, false);
});

test("a single-stream consumer is left alone rather than errored at", async () => {
  // A screen share is one stream: asking it for layer 0 is meaningless.
  const screen = fakeConsumer({ type: "simple" });
  const peer = fakePeer([screen]);
  await controller([]).setMode(peer, "low");
  assert.strictEqual(screen.preferred, null);
});

test("a student who chose their own mode is not overridden by the automatic one", async () => {
  const sent = [];
  const consumer = fakeConsumer();
  const peer = fakePeer([consumer]);
  const ctl = controller(sent);
  // The real order: the consumer exists first, then the student chooses.
  await ctl.onConsumerCreated(peer, consumer);
  await ctl.setMode(peer, "low");
  sent.length = 0;

  // The server reports no layers; the student's own choice must stand, and
  // they must not be told their connection failed.
  consumer.handlers.layerschange(null);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(ctl.modeOf(peer), "low");
});

test("reporting a rung tells the student which one, and clears the countdown", async () => {
  const sent = [];
  const consumer = fakeConsumer();
  const peer = fakePeer([consumer]);
  const ctl = controller(sent);
  await ctl.onConsumerCreated(peer, consumer);
  sent.length = 0;

  consumer.handlers.layerschange({ spatialLayer: 1, temporalLayer: 2 });
  assert.deepStrictEqual(sent, [
    {
      event: "stream-quality",
      payload: { producerId: "p1", spatialLayer: 1, temporalLayer: 2, top: 2 },
    },
  ]);
});

test("the teacher turning their camera off is not reported as a failing line", async () => {
  const sent = [];
  const consumer = fakeConsumer();
  consumer.producerPaused = true;
  const peer = fakePeer([consumer]);
  const ctl = controller(sent);
  await ctl.onConsumerCreated(peer, consumer);
  sent.length = 0;

  consumer.handlers.layerschange(null);
  assert.deepStrictEqual(sent, []);
});
