/**
 * What to call the class, for showing beside the meeting id.
 *
 * A room id is a ScheduleID -- 10242 -- which tells a student nothing about
 * which lesson they are in. ClassSubjectName is the platform's own name for
 * it ("2027 NEET 2027 Physics tamil"), already carries the class and the
 * medium, and is the name the same person sees everywhere else on the site.
 * Using anything assembled here instead would be a second, competing name for
 * the same thing.
 *
 * Pure, so the fallbacks can be pinned without a database.
 */

/** Long enough for the longest real subject name, short enough to sit in a strip. */
const MAX = 80;

function clean(value) {
  if (value == null) return "";
  // Collapsed because these are typed by people into a web form, and a name
  // with a double space in it looks like a rendering fault rather than data.
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * @param {object|null} meeting  a row from resolveMeeting
 * @returns {string|null} the name to show, or null when there is nothing worth showing
 */
function classLabel(meeting) {
  if (!meeting) return null;
  // MeetingTitle second: it is free text a teacher may have left empty or
  // filled with "test", whereas the subject name is structural.
  const chosen = clean(meeting.subject) || clean(meeting.title);
  if (!chosen) return null;
  return chosen.length > MAX ? `${chosen.slice(0, MAX - 1).trimEnd()}…` : chosen;
}

module.exports = { classLabel, MAX };
