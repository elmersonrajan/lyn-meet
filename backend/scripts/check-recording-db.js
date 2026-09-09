#!/usr/bin/env node
/**
 * Answers "why is YouTubeRecords not updating?" in one command.
 *
 * The link between a finished recording and the platform can break in several
 * places, and from outside they all look the same -- no row. This prints which
 * one it is: whether writes are switched on, whether the server knows its own
 * public address, whether the table can be read at all and what columns it
 * has, and then one line per recording saying published or not, with a reason.
 *
 * Usage:
 *   node scripts/check-recording-db.js            # report only, writes nothing
 *   node scripts/check-recording-db.js --publish  # then retry the missing rows
 *
 * Exits non-zero when something is rendered and unpublished, so it is usable
 * from a cron job or a deploy check.
 */
require("dotenv").config();

const publishRecording = require("../src/recording/publishRecording");
const db = require("../src/db/pool");

async function main() {
  const doPublish = process.argv.includes("--publish");
  const report = await publishRecording.report();

  console.log("YouTubeRecords publishing");
  console.log("  writes enabled :", report.enabled ? "yes" : "NO (RECORDING_DB_WRITES)");
  console.log("  public base URL:", report.baseUrl || "NOT SET (RECORDING_PUBLIC_BASE_URL)");
  console.log("  database       :", report.database || "NOT SET (DB_NAME)");
  /**
   * Always "no" here, and that is correct: this script is its own short-lived
   * process and never subscribes to anything. The server does. Saying
   * "start() has not run" read like a fault and sent somebody looking for one.
   */
  console.log(
    "  listening      :",
    report.subscribed ? "yes" : "not in this process — the server subscribes, not this report",
  );
  console.log("  table readable :", report.reachable === null ? "not checked" : report.reachable);
  if (report.columns) console.log("  columns        :", report.columns.join(", "));
  if (report.reason) console.log("  >>", report.reason);

  if (!report.jobs.length) {
    console.log("\nNo recordings have been rendered on this server yet.");
    return 0;
  }

  console.log("\nRecordings, newest first:");
  let missing = 0;
  for (const job of report.jobs) {
    const mark = job.published ? "published" : "MISSING  ";
    if (!job.published) missing += 1;
    console.log(
      `  ${mark} meeting=${job.meetingId} status=${job.status} file=${job.file || "-"}` +
        (job.videoId ? ` VideoID=${job.videoId}` : "") +
        (job.why ? `\n            ${job.why}` : ""),
    );
  }

  if (doPublish && missing) {
    console.log("\nRetrying...");
    const published = await publishRecording.sweep();
    console.log(`  wrote ${published} row(s)`);
    missing -= published;
  } else if (missing) {
    console.log("\nRun again with --publish to write the missing rows.");
  }

  return missing ? 1 : 0;
}

main()
  .then(async (code) => {
    await db.close().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("check failed:", err.message);
    await db.close().catch(() => {});
    process.exit(2);
  });
