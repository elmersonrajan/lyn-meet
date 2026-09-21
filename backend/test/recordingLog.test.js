const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const recordingLog = require("../src/recording/recordingLog");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reclog-"));
}

test("every event is one line, in order, with both clocks", () => {
  // atMs is the one that gets used: "the sound drops out four minutes in" is a
  // position in the file, not a time of day.
  const dir = tmp();
  const t0 = 1_000_000;
  const rec = new recordingLog.RecordingLog(path.join(dir, "a_events.jsonl"), t0);
  rec.note("start", { roomId: "10520" });
  rec.note("side-start", { label: "side:audio:Asha" });

  const rows = recordingLog.read(dir, "a");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].event, "start");
  assert.strictEqual(rows[0].roomId, "10520");
  assert.strictEqual(rows[1].event, "side-start");
  assert.ok(typeof rows[0].atMs === "number" && rows[0].atMs >= 0);
  assert.ok(typeof rows[0].at === "string");
});

test("counters are reported once at the end, not line by line", () => {
  // The board is snapshotted every second. Logging each one would bury the
  // handful of lines that matter.
  const dir = tmp();
  const rec = new recordingLog.RecordingLog(path.join(dir, "b_events.jsonl"));
  for (let i = 0; i < 500; i += 1) rec.count("boardFrames");
  rec.finish("queued-for-render", { frames: 500 });

  const rows = recordingLog.read(dir, "b");
  assert.strictEqual(rows.length, 1, "500 frames must not be 500 lines");
  assert.strictEqual(rows[0].totals.boardFrames, 500);
});

test("a runaway caller cannot fill the disk", () => {
  const dir = tmp();
  const rec = new recordingLog.RecordingLog(path.join(dir, "c_events.jsonl"));
  for (let i = 0; i < recordingLog.MAX_LINES + 50; i += 1) rec.note("noise", { i });
  const rows = recordingLog.read(dir, "c");
  assert.strictEqual(rows.length, recordingLog.MAX_LINES);
  // And it says so rather than pretending it recorded everything.
  rec.finish();
  assert.strictEqual(recordingLog.read(dir, "c").length, recordingLog.MAX_LINES);
});

test("something unserialisable does not take the recording down", () => {
  // A producer or a consumer has circular references; passing one by accident
  // must not throw inside a recording.
  const dir = tmp();
  const rec = new recordingLog.RecordingLog(path.join(dir, "d_events.jsonl"));
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => rec.note("attach", { thing: circular }));
  assert.strictEqual(recordingLog.read(dir, "d").length, 1);
});

test("an unwritable path is survivable", () => {
  // The recording matters more than its log.
  const rec = new recordingLog.RecordingLog(path.join(tmp(), "nope", "deep", "e.jsonl"));
  assert.doesNotThrow(() => rec.note("start", {}));
});

test("a torn last line is reported, not thrown on", () => {
  // What a process killed mid-write leaves behind.
  const dir = tmp();
  const file = path.join(dir, "f_events.jsonl");
  fs.writeFileSync(file, '{"event":"start","atMs":0}\n{"event":"sid', "utf8");
  const rows = recordingLog.read(dir, "f");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].event, "start");
  assert.strictEqual(rows[1].event, "unreadable");
});

test("the text view puts the position first", () => {
  const text = recordingLog.toText([
    { at: "2026-09-13T12:00:00.000Z", atMs: 0, event: "start", roomId: "10520" },
    { at: "2026-09-13T12:04:00.000Z", atMs: 240000, event: "side-stop", bytes: 0 },
  ]);
  assert.ok(text.includes("+0.0s"), text);
  assert.ok(text.includes("+240.0s"), text);
  assert.ok(text.includes("side-stop"), text);
});

test("a log handle does not survive being written to a job file", () => {
  // This is the bug that stopped every render for a day. The render job is
  // written to <id>.job.json and read back before rendering, so anything with
  // methods on it arrives as plain data -- and `events?.note(...)` threw at the
  // first step while captures piled up unrendered.
  //
  // The render must therefore open its own handle, never carry one.
  const dir = tmp();
  const live = new recordingLog.RecordingLog(path.join(dir, "j_events.jsonl"));
  const throughJson = JSON.parse(JSON.stringify({ id: "j", events: live }));

  assert.strictEqual(typeof live.note, "function");
  assert.notStrictEqual(typeof throughJson.events?.note, "function", "methods cannot cross JSON");

  // And reopening appends to the same file rather than starting a new one.
  live.note("capture-ended", {});
  const reopened = recordingLog.open(dir, "j");
  reopened.note("render-step", { step: "compose" });
  const rows = recordingLog.read(dir, "j");
  assert.deepStrictEqual(rows.map((r) => r.event), ["capture-ended", "render-step"]);
});
