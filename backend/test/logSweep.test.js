const test = require("node:test");
const assert = require("node:assert");

const { sweepable, keepCount } = require("../src/recording/logSweep");

/** Newest last, so rank is just the position. */
const rank = (order) => (id) => order.indexOf(id);
const finished = () => true;

const notesFor = (id) => [`${id}_ffmpeg.log`, `${id}_events.jsonl`, `${id}.job.json`];

test("the last recording keeps its notes, the one before it does not", () => {
  const names = [...notesFor("rec_1"), ...notesFor("rec_2")];
  const out = sweepable(names, rank(["rec_1", "rec_2"]), finished, 1);
  assert.deepStrictEqual(out.sort(), notesFor("rec_1").sort());
});

test("the finished recordings themselves are never touched", () => {
  // The whole point. An .mp4 is the deliverable and the sidecar beside it says
  // who could be heard in it -- that belongs to the recording, not to the
  // business of producing it.
  const names = [
    "10252_13SEP26.mp4",
    "10252_13SEP26.json",
    "10249_13SEP26.mp4",
    "10249_13SEP26.json",
    ...notesFor("rec_old"),
    ...notesFor("rec_new"),
  ];
  const out = sweepable(names, rank(["rec_old", "rec_new"]), finished, 1);
  assert.ok(!out.some((f) => f.endsWith(".mp4")), out.join(" "));
  assert.ok(!out.includes("10249_13SEP26.json"), out.join(" "));
  assert.deepStrictEqual(out.sort(), notesFor("rec_old").sort());
});

test("a job still waiting to render is kept, however old", () => {
  // That file is the only thing that brings the class back after a restart.
  // Sweeping it loses the recording outright.
  const names = [...notesFor("rec_stuck"), ...notesFor("rec_new")];
  const out = sweepable(names, rank(["rec_stuck", "rec_new"]), (id) => id !== "rec_stuck", 1);
  assert.ok(!out.includes("rec_stuck.job.json"), out.join(" "));
  // Its logs still go: they are notes, not the recording.
  assert.ok(out.includes("rec_stuck_ffmpeg.log"));
  assert.ok(out.includes("rec_stuck_events.jsonl"));
});

test("keeping more than one is possible", () => {
  const names = [...notesFor("a"), ...notesFor("b"), ...notesFor("c")];
  const out = sweepable(names, rank(["a", "b", "c"]), finished, 2);
  assert.deepStrictEqual(out.sort(), notesFor("a").sort());
});

test("keeping zero sweeps everything finished", () => {
  const names = [...notesFor("a"), ...notesFor("b")];
  const out = sweepable(names, rank(["a", "b"]), finished, 0);
  assert.strictEqual(out.length, 6);
});

test("one recording on a fresh server loses nothing", () => {
  const names = notesFor("only");
  assert.deepStrictEqual(sweepable(names, rank(["only"]), finished, 1), []);
});

test("files that are not notes are ignored entirely", () => {
  const names = ["board.ffconcat", "rec_1.sdp", "rec_1_side0.mkv", "notes.txt", ...notesFor("old"), ...notesFor("new")];
  const out = sweepable(names, rank(["old", "new"]), finished, 1);
  assert.deepStrictEqual(out.sort(), notesFor("old").sort());
});

test("the default is the last recording only", () => {
  const before = process.env.RECORDING_KEEP_LOGS;
  try {
    delete process.env.RECORDING_KEEP_LOGS;
    assert.strictEqual(keepCount(), 1);
    process.env.RECORDING_KEEP_LOGS = "banana";
    assert.strictEqual(keepCount(), 1);
    process.env.RECORDING_KEEP_LOGS = "0";
    assert.strictEqual(keepCount(), 0, "0 must mean none, not fall back to 1");
    process.env.RECORDING_KEEP_LOGS = "5";
    assert.strictEqual(keepCount(), 5);
  } finally {
    if (before === undefined) delete process.env.RECORDING_KEEP_LOGS;
    else process.env.RECORDING_KEEP_LOGS = before;
  }
});
