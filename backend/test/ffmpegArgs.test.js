const test = require("node:test");
const assert = require("node:assert");

const {
  buildSdp,
  buildComposeArgs,
  PIP_W,
  PIP_H,
  PIP_MARGIN,
  PRESET,
  CRF,
} = require("../src/recording/ffmpegArgs");

const rtp = (port) => ({ remoteRtpPort: port, payloadType: 96, codecName: "VP8", clockRate: 90000 });

/** The -i arguments, in order. Their positions are what the filter graph indexes. */
function inputs(args) {
  return args.filter((a, i) => args[i - 1] === "-i");
}

function graph(args) {
  return args[args.indexOf("-filter_complex") + 1];
}

test("the SDP lists camera then screen, which is the order the layout assumes", () => {
  const sdp = buildSdp({ audio: { ...rtp(20000), codecName: "opus", clockRate: 48000 }, cam: rtp(20002), screen: rtp(20004) });
  const media = sdp.split("\n").filter((l) => l.startsWith("m="));
  assert.deepStrictEqual(media.map((l) => l.split(" ")[0]), ["m=audio", "m=video", "m=video"]);
  assert.ok(media[1].includes("20002"), media[1]);
  assert.ok(media[2].includes("20004"), media[2]);
});

test("a class with a camera and a board lays the camera over the board", () => {
  const args = buildComposeArgs({
    livePath: "live.mkv",
    boardVideo: "board.mp4",
    outputPath: "out.mp4",
    camIndex: 0,
    screenIndex: null,
    hasAudio: true,
  });
  assert.deepStrictEqual(inputs(args), ["live.mkv", "board.mp4"]);
  const g = graph(args);
  assert.ok(g.includes("[1:v]"), g); // the board is input 1
  assert.ok(g.includes("[0:v:0]"), g); // the camera is stream 0 of input 0
  assert.ok(g.includes("[cam]overlay=W-w-"), g);
  assert.ok(args.includes("0:a:0"), args.join(" "));
});

/**
 * The case that used to be thrown away: a lesson on the board with the camera
 * off and the microphone muted. Nothing reaches the RTP capture, so there is
 * no input 0 -- and every index in the filter graph has to move with it.
 */
test("a board-only class composes with no capture file at all", () => {
  const args = buildComposeArgs({
    livePath: null,
    boardVideo: "board.mp4",
    outputPath: "out.mp4",
    camIndex: 3,
    screenIndex: 4,
    hasAudio: true,
  });
  assert.deepStrictEqual(inputs(args), ["board.mp4"]);
  const g = graph(args);
  // The board is now input 0, and nothing refers to streams that do not exist.
  assert.ok(g.includes("[0:v]"), g);
  assert.ok(!g.includes(":v:3"), g);
  assert.ok(!g.includes(":v:4"), g);
  // hasAudio was a claim about a file that is not there.
  assert.ok(!args.includes("0:a:0"), args.join(" "));
  assert.ok(!args.includes("-c:a"), args.join(" "));
});

test("a board-only class still carries the mixed voices", () => {
  const args = buildComposeArgs({
    livePath: null,
    boardVideo: "board.mp4",
    outputPath: "out.mp4",
    camIndex: null,
    screenIndex: null,
    hasAudio: false,
    audioPath: "mix.m4a",
  });
  assert.deepStrictEqual(inputs(args), ["board.mp4", "mix.m4a"]);
  assert.ok(args.includes("1:a:0"), args.join(" "));
  // Already AAC from the mix step; re-encoding it would be a second lossy pass.
  assert.strictEqual(args[args.indexOf("-c:a") + 1], "copy");
});

test("a side screen keeps its own input position when there is no capture", () => {
  const args = buildComposeArgs({
    livePath: null,
    boardVideo: "board.mp4",
    outputPath: "out.mp4",
    camIndex: null,
    screenIndex: null,
    hasAudio: false,
    sideScreen: { path: "share.mkv", offsetMs: 4000 },
    audioPath: "mix.m4a",
  });
  assert.deepStrictEqual(inputs(args), ["board.mp4", "share.mkv", "mix.m4a"]);
  const g = graph(args);
  assert.ok(g.includes("[1:v]"), g);
  // Transparent until the share began, so the board shows through before it.
  assert.ok(g.includes("tpad=start_duration=4.000"), g);
  assert.ok(args.includes("2:a:0"), args.join(" "));
});

test("the camera inset is an even number of pixels wide", () => {
  // An odd width is rejected outright by H.264 with yuv420p.
  assert.strictEqual(PIP_W % 2, 0);
});

test("a colour base is bounded by the audio, a board base is not", () => {
  const withBoard = buildComposeArgs({
    livePath: "live.mkv",
    boardVideo: "board.mp4",
    outputPath: "o.mp4",
    camIndex: null,
    screenIndex: null,
    hasAudio: true,
  });
  assert.ok(!withBoard.includes("-shortest"), "the board already bounds the file");

  const noPicture = buildComposeArgs({
    livePath: "live.mkv",
    boardVideo: null,
    outputPath: "o.mp4",
    camIndex: null,
    screenIndex: null,
    hasAudio: true,
  });
  // A colour source runs forever; without this ffmpeg has no reason to stop.
  assert.ok(noPicture.includes("-shortest"), noPicture.join(" "));
});

/* ---------- The camera inset ---------- */

test("the camera inset is a quarter of the frame, not a sixth", () => {
  // A sixth of 1280 is 214 pixels: a face too small to read an expression on,
  // which is what a teacher means by "the camera looks bad in the recording".
  assert.strictEqual(PIP_W, 320);
  assert.strictEqual(PIP_H, 180);
  assert.strictEqual(PIP_W / PIP_H, 16 / 9);
});

test("the inset is scaled with lanczos, not the default", () => {
  const args = buildComposeArgs({
    livePath: "live.mkv",
    boardVideo: "board.mp4",
    outputPath: "o.mp4",
    camIndex: 0,
    screenIndex: null,
    hasAudio: true,
  });
  const g = graph(args);
  // 1280 down to 320 is a 4x reduction; bilinear turns fine detail to mush at
  // that ratio and this is the only detailed part of the frame.
  assert.ok(g.includes(`scale=${PIP_W}:${PIP_H}:force_original_aspect_ratio=decrease:flags=lanczos`), g);
});

test("the inset stays clear of the frame edge", () => {
  const args = buildComposeArgs({
    livePath: "live.mkv",
    boardVideo: "board.mp4",
    outputPath: "o.mp4",
    camIndex: 0,
    screenIndex: null,
    hasAudio: false,
  });
  assert.ok(graph(args).includes(`overlay=W-w-${PIP_MARGIN}:H-h-${PIP_MARGIN}`), graph(args));
});

test("the encode settings are the ones configured", () => {
  const args = buildComposeArgs({
    livePath: "live.mkv",
    boardVideo: "board.mp4",
    outputPath: "o.mp4",
    camIndex: null,
    screenIndex: null,
    hasAudio: false,
  });
  assert.strictEqual(args[args.indexOf("-preset") + 1], PRESET);
  assert.strictEqual(args[args.indexOf("-crf") + 1], CRF);
});
