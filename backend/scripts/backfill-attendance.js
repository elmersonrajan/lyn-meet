#!/usr/bin/env node
/**
 * Replays attendance from the file into the platform's tables.
 *
 * The mirror writes a register row the moment somebody leaves. When it cannot
 * -- the database was down, the credentials were wrong, the server was killed
 * before the last write landed -- the events are still on disk, which is the
 * whole reason the file is the record and the tables are a copy of it.
 *
 * This is the copy being made again. It is safe to run repeatedly: register
 * rows are upserted, and only rows this server wrote itself are overwritten.
 *
 * Usage:
 *   node scripts/backfill-attendance.js 10197            # every day in that log
 *   node scripts/backfill-attendance.js 10197 27-08-2026 # one class-day
 *   node scripts/backfill-attendance.js --all            # every meeting on disk
 *   node scripts/backfill-attendance.js --all --dry-run  # show, write nothing
 *
 * Exits non-zero if anything failed, so it can be trusted in a cron job.
 */
require("dotenv").config();

const attendanceLog = require("../src/attendance/attendanceLog");
const attendanceDb = require("../src/attendance/attendanceDb");
const db = require("../src/db/pool");

function parseArgs(argv) {
  const args = { meetings: [], date: null, all: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (/^\d{2}-\d{2}-\d{4}$/.test(arg)) args.date = arg;
    else args.meetings.push(arg);
  }
  return args;
}

/** Every meeting-day the file store knows about, as (meetingId, date) pairs. */
function everyMeetingDay() {
  return attendanceLog.listMeetings().map((m) => ({ meetingId: m.meetingId, date: m.date }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.all && !args.meetings.length) {
    console.error("usage: node scripts/backfill-attendance.js <meetingId> [DD-MM-YYYY] | --all");
    process.exit(2);
  }
  if (!process.env.DB_HOST) {
    console.error("DB_HOST is not set — there is nothing to back-fill into");
    process.exit(2);
  }

  const targets = args.all
    ? everyMeetingDay()
    : args.meetings.flatMap((meetingId) =>
        args.date
          ? [{ meetingId, date: args.date }]
          : attendanceLog
              .buildReport(meetingId)
              .availableDates.map((date) => ({ meetingId, date })),
      );

  if (!targets.length) {
    console.log("nothing on disk to back-fill");
    return 0;
  }

  let failures = 0;
  for (const { meetingId, date } of targets) {
    const label = `${meetingId} ${date}`;
    try {
      if (args.dryRun) {
        const report = attendanceLog.buildReport(meetingId, { date });
        const named = report.people.filter((p) => p.email);
        console.log(
          `${label}  ${named.length} row(s) would be written` +
            (named.length === report.people.length
              ? ""
              : `, ${report.people.length - named.length} skipped with no account`),
        );
        continue;
      }
      const result = await attendanceDb.backfill(meetingId, { date });
      console.log(`${label}  schedule ${result.scheduleId}  ${result.written.length} row(s)`);
      for (const row of result.written) {
        console.log(`    ${row.role.padEnd(11)} ${row.email}  ${row.duration}`);
      }
    } catch (err) {
      failures += 1;
      console.error(`${label}  FAILED: ${err.message}`);
    }
  }

  return failures ? 1 : 0;
}

main()
  .then(async (code) => {
    await db.close();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await db.close().catch(() => {});
    process.exit(1);
  });
