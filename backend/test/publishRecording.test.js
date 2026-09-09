const test = require("node:test");
const assert = require("node:assert");

const { insertFor, scheduleIdOf } = require("../src/recording/publishRecording");

/** The two columns this app knows about, as a table that needs nothing else. */
const MINIMAL = [
  { name: "VideoID", type: "int(11)", nullable: false, hasDefault: false, generated: true },
  { name: "ScheduleID", type: "int(11)", nullable: false, hasDefault: false, generated: false },
  { name: "VideoURL", type: "varchar(500)", nullable: true, hasDefault: false, generated: false },
];

test("a room id is only a ScheduleID when it looks like one", () => {
  assert.strictEqual(scheduleIdOf("10197"), 10197);
  assert.strictEqual(scheduleIdOf(" 10197 "), 10197);
  assert.strictEqual(scheduleIdOf("demo-room"), null);
  assert.strictEqual(scheduleIdOf("10197x"), null);
  assert.strictEqual(scheduleIdOf(""), null);
  assert.strictEqual(scheduleIdOf(null), null);
});

test("the plainest table gets the plainest insert", () => {
  const { sql, params } = insertFor(MINIMAL, 10197, "https://x/recordings/a.mp4");
  assert.strictEqual(sql, "INSERT INTO YouTubeRecords (`ScheduleID`, `VideoURL`) VALUES (?, ?)");
  assert.deepStrictEqual(params, [10197, "https://x/recordings/a.mp4"]);
});

test("an auto-increment key is never written", () => {
  const { sql } = insertFor(MINIMAL, 1, "u");
  assert.ok(!sql.includes("VideoID"), sql);
});

test("a NOT NULL column with no default is filled, or the whole row is refused", () => {
  const schema = [
    ...MINIMAL,
    { name: "Title", type: "varchar(200)", nullable: false, hasDefault: false, generated: false },
    { name: "Views", type: "int(11)", nullable: false, hasDefault: false, generated: false },
    { name: "CreatedOn", type: "datetime", nullable: false, hasDefault: false, generated: false },
  ];
  const { sql, params } = insertFor(schema, 10197, "u", Date.UTC(2026, 8, 9, 12, 0, 0));
  assert.ok(sql.includes("`Title`") && sql.includes("`Views`") && sql.includes("`CreatedOn`"), sql);
  assert.strictEqual(params[2], "");
  assert.strictEqual(params[3], 0);
  // The class's own timezone, in the form a DATETIME column takes.
  assert.match(params[4], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("a nullable column is left alone", () => {
  const schema = [
    ...MINIMAL,
    { name: "Notes", type: "text", nullable: true, hasDefault: false, generated: false },
  ];
  assert.ok(!insertFor(schema, 1, "u").sql.includes("Notes"));
});

test("a column with a default is left to its default", () => {
  const schema = [
    ...MINIMAL,
    { name: "Status", type: "tinyint(1)", nullable: false, hasDefault: true, generated: false },
  ];
  assert.ok(!insertFor(schema, 1, "u").sql.includes("Status"));
});

test("a row this server wrote says so, even where the column allows null", () => {
  const schema = [
    ...MINIMAL,
    { name: "UploadedBy", type: "varchar(100)", nullable: true, hasDefault: false, generated: false },
  ];
  const { sql, params } = insertFor(schema, 1, "u");
  assert.ok(sql.includes("`UploadedBy`"), sql);
  assert.strictEqual(params[2], "LYN MEET");
});

test("date and time columns get the right shape, not a datetime in all three", () => {
  const schema = [
    ...MINIMAL,
    { name: "OnDate", type: "date", nullable: false, hasDefault: false, generated: false },
    { name: "AtTime", type: "time", nullable: false, hasDefault: false, generated: false },
  ];
  const { params } = insertFor(schema, 1, "u", Date.UTC(2026, 8, 9, 12, 0, 0));
  assert.match(params[2], /^\d{4}-\d{2}-\d{2}$/);
  assert.match(params[3], /^\d{2}:\d{2}:\d{2}$/);
});

test("the values line up with the columns, whatever the table holds", () => {
  const schema = [
    ...MINIMAL,
    { name: "A", type: "varchar(10)", nullable: false, hasDefault: false, generated: false },
    { name: "B", type: "int(11)", nullable: false, hasDefault: false, generated: false },
  ];
  const { sql, params } = insertFor(schema, 7, "u");
  const named = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(", ").length;
  assert.strictEqual(named, params.length);
});
