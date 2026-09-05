/**
 * The formats the platform's attendance tables are written in.
 *
 * These are the things that fail silently. A duration of "1h 5m" instead of
 * "1 hr 5 min", a time of "06:59 PM" instead of "6:59 PM", or a timestamp
 * stored in UTC rather than class time, all insert perfectly happily and are
 * only noticed when somebody reads a report weeks later and finds a class that
 * apparently started at half past one in the afternoon.
 *
 * Run with:  node --test test/
 *
 * No database is needed: everything here is pure. The statements themselves
 * are exercised against clone tables separately.
 */
const test = require("node:test");
const assert = require("node:assert");

process.env.ATTENDANCE_TIMEZONE = "Asia/Kolkata";

const attendanceDb = require("../src/attendance/attendanceDb");
const publishRecording = require("../src/recording/publishRecording");

/** A wall-clock time in Asia/Kolkata, which is UTC+5:30 and never shifts. */
const ist = (day, hour, minute, second = 0) =>
  Date.UTC(2026, 8, day, hour - 5, minute - 30, second);

test("durations read the way the platform writes them", () => {
  assert.equal(attendanceDb.durationText(65 * 60 * 1000), "1 hr 5 min");
  assert.equal(attendanceDb.durationText(60 * 60 * 1000), "1 hr");
  assert.equal(attendanceDb.durationText(45 * 60 * 1000), "45 min");
  assert.equal(attendanceDb.durationText(90 * 60 * 1000), "1 hr 30 min");
  // Somebody who looked in and left. The column has plenty of these.
  assert.equal(attendanceDb.durationText(12 * 1000), "12 sec");
  assert.equal(attendanceDb.durationText(0), "0 sec");
  // Never negative, whatever the clock did.
  assert.equal(attendanceDb.durationText(-5000), "0 sec");
});

test("seconds are floored, not rounded up into a minute that was not there", () => {
  assert.equal(attendanceDb.durationText(59 * 1000), "59 sec");
  assert.equal(attendanceDb.durationText(59.9 * 60 * 1000), "59 min");
});

test("a duration too long for the column degrades instead of being rejected", () => {
  // varchar(11): "12 hr 30 min" is 12 characters and strict mode refuses it.
  const twelveAndAHalfHours = (12 * 60 + 30) * 60 * 1000;
  assert.equal(attendanceDb.durationText(twelveAndAHalfHours), "12 hr 30 min");
  assert.equal(attendanceDb.fitDuration(twelveAndAHalfHours, 11), "750 min");
  assert.ok(attendanceDb.fitDuration(twelveAndAHalfHours, 11).length <= 11);
  // Anything that fits is left exactly as it is.
  assert.equal(attendanceDb.fitDuration(65 * 60 * 1000, 11), "1 hr 5 min");
});

test("times carry no leading zero on the hour", () => {
  assert.equal(attendanceDb.clockTime(ist(5, 18, 59)), "6:59 PM");
  assert.equal(attendanceDb.clockTime(ist(5, 8, 5)), "8:05 AM");
  assert.equal(attendanceDb.clockTime(ist(5, 12, 30)), "12:30 PM");
  assert.equal(attendanceDb.clockTime(ist(5, 0, 30)), "12:30 AM");
  assert.equal(attendanceDb.clockTime(null), "");
});

test("timestamps are class time, not UTC", () => {
  // The whole point: a 6:59 PM class must not be stored as 13:29.
  assert.equal(attendanceDb.stamp(ist(5, 18, 59, 3)), "2026-09-05 18:59:03");
  assert.equal(attendanceDb.stamp(ist(5, 0, 0)), "2026-09-05 00:00:00");
  // A class that runs past midnight lands on the next date, as it should.
  assert.equal(attendanceDb.stamp(ist(5, 23, 45) + 30 * 60 * 1000), "2026-09-06 00:15:00");
});

test("only a real ScheduleID gets a row", () => {
  assert.equal(attendanceDb.scheduleIdOf("10197"), 10197);
  assert.equal(attendanceDb.scheduleIdOf(" 10197 "), 10197);
  // Ad-hoc and test rooms have no class to attach attendance to.
  assert.equal(attendanceDb.scheduleIdOf("MATH-101"), null);
  assert.equal(attendanceDb.scheduleIdOf(""), null);
  assert.equal(attendanceDb.scheduleIdOf(null), null);
  assert.equal(attendanceDb.scheduleIdOf("10197; DROP TABLE Attendance"), null);
});

test("an event with no account behind it is never mirrored", () => {
  // Every one of these tables is keyed by email address. Local development
  // with auth disabled must not try to write rows keyed on nothing.
  assert.doesNotThrow(() => attendanceDb.handleEvent({ meetingId: "10197", type: "join" }));
  assert.doesNotThrow(() => attendanceDb.handleEvent(null));
  assert.doesNotThrow(() =>
    attendanceDb.handleEvent({ meetingId: "MATH-101", type: "join", email: "a@b.com" }),
  );
});

test("rows this server writes are marked, so it only ever overwrites its own", () => {
  assert.equal(attendanceDb.config.uploadedBy, "LYN MEET");
});

test("a published recording points at this server's playback address", () => {
  process.env.RECORDING_PUBLIC_BASE_URL = "https://meet.lynindia.in";
  assert.equal(
    publishRecording.urlFor("10197_05SEP26.mp4"),
    "https://meet.lynindia.in/recordings/10197_05SEP26.mp4",
  );
  // A trailing slash in configuration must not produce a double slash.
  process.env.RECORDING_PUBLIC_BASE_URL = "https://meet.lynindia.in/";
  assert.equal(
    publishRecording.urlFor("10197_05SEP26.mp4"),
    "https://meet.lynindia.in/recordings/10197_05SEP26.mp4",
  );
  // A file name is a path segment, never a way out of the recordings folder.
  assert.equal(
    publishRecording.urlFor("a b/../c.mp4"),
    "https://meet.lynindia.in/recordings/a%20b%2F..%2Fc.mp4",
  );
});
