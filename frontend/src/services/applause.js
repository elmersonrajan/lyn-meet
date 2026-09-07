/**
 * A round of applause, built rather than downloaded.
 *
 * A clap is a very short burst of noise with a fast decay, and applause is a
 * few dozen of them overlapping at slightly different pitches. That is cheap
 * enough to synthesise that shipping an audio file would be the more expensive
 * option -- an asset to bundle, to cache, to get 404 on, and to fetch again on
 * a connection the class is already sharing with a lesson.
 *
 * It is deliberately short and not loud. This plays over a teacher's voice,
 * possibly forty times in a lesson, and praise that makes people reach for the
 * volume control is praise nobody will use twice.
 */

/**
 * One context for the page.
 *
 * Browsers allow only a handful of AudioContexts and never collect them
 * eagerly, so creating one per burst of applause would stop working part-way
 * through a lively lesson.
 */
let audioContext = null;

function context() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx();
  return audioContext;
}

/**
 * A single clap, as a short buffer of noise that dies away quickly.
 *
 * Built once and reused: every clap is the same 70 milliseconds of noise
 * played at a slightly different speed through a slightly different filter,
 * which is what stops thirty of them sounding like one loud one.
 */
let clapBuffer = null;

function buildClap(ctx) {
  if (clapBuffer) return clapBuffer;
  const length = Math.floor(ctx.sampleRate * 0.07);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const progress = i / length;
    // Almost all of the energy in the first few milliseconds, then gone. A
    // slower decay is a hand-slap; this is a clap.
    const envelope = Math.exp(-22 * progress);
    samples[i] = (Math.random() * 2 - 1) * envelope;
  }
  clapBuffer = buffer;
  return clapBuffer;
}

/**
 * @param {{volume?: number, claps?: number, durationSec?: number}} opts
 */
export function playApplause({ volume = 0.22, claps = 34, durationSec = 2.2 } = {}) {
  try {
    const ctx = context();
    if (!ctx) return;

    /**
     * A context created before the viewer has interacted with the page starts
     * suspended. Joining the meeting is an interaction, so this usually
     * resolves -- and when it does not, the celebration is silent, which is a
     * perfectly acceptable outcome for a sound effect.
     */
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const buffer = buildClap(ctx);
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);

    const now = ctx.currentTime;
    for (let i = 0; i < claps; i += 1) {
      // Front-loaded: a room bursts into applause and then tails off, rather
      // than clapping evenly for two seconds like a metronome.
      const at = now + Math.random() ** 1.7 * durationSec;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Every pair of hands is a different size.
      source.playbackRate.value = 0.8 + Math.random() * 0.6;

      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      // Where a clap lives. Below this it is a thud, above it a hiss.
      band.frequency.value = 1100 + Math.random() * 1600;
      band.Q.value = 0.7;

      const gain = ctx.createGain();
      gain.gain.value = 0.4 + Math.random() * 0.6;

      source.connect(band);
      band.connect(gain);

      // Spread across the room where the browser can do it; harmless where it
      // cannot.
      if (typeof ctx.createStereoPanner === "function") {
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.random() * 1.6 - 0.8;
        gain.connect(pan);
        pan.connect(master);
      } else {
        gain.connect(master);
      }

      source.start(at);
      source.stop(at + 0.09);
    }

    // Released once the applause has finished, so a lesson does not accumulate
    // a node per clap per celebration.
    setTimeout(() => {
      try {
        master.disconnect();
      } catch (err) {
        console.warn("[applause] disconnect failed", err.message);
      }
    }, (durationSec + 0.5) * 1000);
  } catch (err) {
    // Sound is the decoration on this feature, never the feature.
    console.warn("[applause] could not play", err.message);
  }
}
