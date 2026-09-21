const test = require("node:test");
const assert = require("node:assert");

const { buildAudioMixArgs } = require("../src/recording/ffmpegArgs");

function graph(args) {
  return args[args.indexOf("-filter_complex") + 1];
}

const voice = (offsetMs, path = "v.mkv") => ({ path, offsetMs, name: "A", role: "student" });

test("a voice is pinned to zero before it is delayed, not after", () => {
  // The order is the bug. A side capture is written from live RTP and killed
  // at the end of a class, so its own start timestamp is not to be trusted --
  // delaying an unknown start by a known amount gives an unknown position, and
  // every voice ended up piled at the front of the file.
  const g = graph(buildAudioMixArgs({ livePath: "l.mkv", hasAudio: true, voices: [voice(19463)], outputPath: "o.m4a" }));
  const chain = g.split(";").find((c) => c.includes("a_v0"));
  assert.ok(chain.includes("aresample=async=1:first_pts=0"), chain);
  assert.ok(
    chain.indexOf("first_pts=0") < chain.indexOf("adelay="),
    "normalise first, then place: " + chain,
  );
});

test("the teacher is pinned the same way", () => {
  // Both go into one mix; treating them differently is what let them drift
  // apart in the first place.
  const g = graph(buildAudioMixArgs({ livePath: "l.mkv", hasAudio: true, voices: [], outputPath: "o.m4a" }));
  assert.ok(g.includes("aresample=async=1:first_pts=0[a_teacher]"), g);
});

test("a voice that began with the recording is not delayed at all", () => {
  // Someone already unmuted when Record was pressed belongs at zero, and a
  // delay of 0 is a filter that can only introduce error.
  const g = graph(buildAudioMixArgs({ livePath: "l.mkv", hasAudio: true, voices: [voice(0)], outputPath: "o.m4a" }));
  const chain = g.split(";").find((c) => c.includes("a_v0"));
  assert.ok(!chain.includes("adelay"), chain);
  assert.ok(chain.includes("first_pts=0"), chain);
});

test("every voice keeps its own offset", () => {
  const g = graph(
    buildAudioMixArgs({
      livePath: "l.mkv",
      hasAudio: true,
      voices: [voice(19463, "a.mkv"), voice(1314256, "b.mkv")],
      outputPath: "o.m4a",
    }),
  );
  assert.ok(g.includes("adelay=19463:all=1"), g);
  assert.ok(g.includes("adelay=1314256:all=1"), g);
});

test("voices with no teacher audio still mix", () => {
  // A class taught on the board with the teacher muted is still a class.
  const args = buildAudioMixArgs({ livePath: "l.mkv", hasAudio: false, voices: [voice(5000)], outputPath: "o.m4a" });
  assert.ok(args);
  assert.ok(!graph(args).includes("a_teacher"), graph(args));
});

test("nothing to mix is null, not an empty command", () => {
  assert.strictEqual(buildAudioMixArgs({ livePath: "l.mkv", hasAudio: false, voices: [], outputPath: "o.m4a" }), null);
});

test("the mix never quietens the teacher when somebody else speaks", () => {
  // normalize=0. Otherwise the teacher drops in volume every time a student
  // unmutes, which is most of a lesson.
  const g = graph(
    buildAudioMixArgs({ livePath: "l.mkv", hasAudio: true, voices: [voice(1000)], outputPath: "o.m4a" }),
  );
  assert.ok(g.includes("normalize=0"), g);
});
