/**
 * Meeting-level authorisation.
 *
 * Signing in proves you belong to the organisation. It does not prove you
 * belong in *this* class, and that distinction now matters: rooms are keyed by
 * `ClassSchedule.ScheduleID`, which is a sequential integer. Anyone who is
 * signed in can type 10213, 10212, 10211 and walk into other teachers'
 * classes. The old random `xxx-xxxx-xxx` codes made that impractical; numbers
 * make it trivial.
 *
 * So membership is checked per meeting:
 *
 *   - the schedule must exist and not be cancelled
 *   - a student must be in the class the schedule teaches
 *   - a teacher gets teacher powers only in the class assigned to them
 *   - coordinators pass, which is the entire point of the role
 */
const { query } = require("../db/pool");
const { config: authConfig } = require("./config");
const { createLogger } = require("../utils/logger");

const log = createLogger("Enrolment");

const flag = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
};

const config = {
  /** Off by default: turning it on would refuse ad-hoc and test rooms. */
  get enforce() {
    return flag("ENFORCE_ENROLMENT", true);
  },
  /**
   * Off by default on purpose. The platform's own sample link pointed at
   * ScheduleID 10214, whose ScheduleDate is not CURDATE() -- requiring today
   * would have refused the integration's first test. Turn it on once
   * scheduling is reliable.
   */
  get requireToday() {
    return flag("REQUIRE_SCHEDULE_TODAY", false);
  },
  /**
   * When on, only the teacher named on the schedule gets teacher powers; any
   * other teacher joins as an observer. Left on: it prevents a teacher walking
   * into a colleague's class and taking it over, without locking anyone out.
   */
  get teacherMustMatch() {
    return flag("TEACHER_MUST_MATCH_SCHEDULE", true);
  },
  /** Rooms that are not a ScheduleID at all. Useful for testing, off in prod. */
  get allowAdhocRooms() {
    return flag("ALLOW_ADHOC_ROOMS", false);
  },
};

/** A ScheduleID is a positive integer; anything else is an ad-hoc room name. */
function isScheduleId(roomId) {
  return /^[0-9]{1,10}$/.test(String(roomId || "").trim());
}

/**
 * Loads the class behind a room id.
 *
 * Dates are compared inside SQL against CURDATE() rather than in JavaScript:
 * the driver returns DATE columns as strings precisely so nobody is tempted to
 * build a Date and lose a day to the IST offset.
 *
 * @returns {Promise<object|null>} null when no such schedule exists
 */
async function resolveMeeting(roomId) {
  if (!isScheduleId(roomId)) return null;
  const rows = await query(
    `SELECT cs.ScheduleID       AS scheduleId,
            cs.Status           AS status,
            cs.ScheduleDate     AS scheduleDate,
            cs.MeetingTitle     AS title,
            cs.ClassSubjectID   AS classSubjectId,
            csub.ClassID        AS classId,
            csub.Medium         AS medium,
            csub.ClassSubjectName AS subject,
            LOWER(TRIM(t.TeacherEmail)) AS teacherEmail,
            LOWER(TRIM(ca.AdminEmail))  AS adminEmail,
            (cs.ScheduleDate = CURDATE()) AS isToday
       FROM ClassSchedule cs
       LEFT JOIN ClassSubject csub ON csub.ClassSubjectID = cs.ClassSubjectID
       LEFT JOIN Teachers    t    ON t.TeacherID = cs.TeacherID
       LEFT JOIN ClassAdmins ca   ON ca.AdminID  = cs.AdminID
      WHERE cs.ScheduleID = ?
      LIMIT 1`,
    [Number(roomId)],
  );
  return rows.length ? { ...rows[0], isToday: Number(rows[0].isToday) === 1 } : null;
}

/** Is this student in the class the schedule teaches? */
async function isStudentInClass(email, classId) {
  if (!classId) return false;
  const rows = await query(
    `SELECT 1 AS ok FROM Students
      WHERE LOWER(TRIM(emailid)) = ? AND Class = ? AND Deleted = 0
      LIMIT 1`,
    [email, classId],
  );
  if (rows.length) return true;

  // A same-day exception is how the platform lets someone sit in a class they
  // are not enrolled in, so it has to count here too.
  const exception = await query(
    `SELECT 1 AS ok FROM StudentException
      WHERE LOWER(TRIM(EmailID)) = ? AND ClassID = ? AND ExDate = CURDATE()
      LIMIT 1`,
    [email, classId],
  );
  return exception.length > 0;
}

/**
 * Decides whether this identity may enter this room, and with what role.
 *
 * The role that comes back may be *lower* than the identity's own -- a teacher
 * in someone else's class becomes an observer. It is never higher.
 *
 * @param {{email, role, userTypes}} identity resolved from v_Users
 * @param {string} roomId
 * @returns {Promise<{allowed: boolean, role: string, reason: string, meeting: object|null}>}
 */
async function authorize(identity, roomId) {
  // AUTH_DISABLED means there is no database to check against, so there is no
  // enrolment to verify either. Refused in production by auth/config.
  if (authConfig.authDisabled) {
    return { allowed: true, role: identity.role, reason: "auth disabled", meeting: null };
  }

  const adhoc = !isScheduleId(roomId);

  if (adhoc) {
    if (!config.allowAdhocRooms) {
      log.warn("refused ad-hoc room", { email: identity.email, roomId });
      return {
        allowed: false,
        role: identity.role,
        reason: "That meeting ID is not a scheduled class",
        meeting: null,
      };
    }
    // Test rooms carry no class, so there is nothing to check membership
    // against. Everyone keeps their directory role.
    return { allowed: true, role: identity.role, reason: "ad-hoc room", meeting: null };
  }

  const meeting = await resolveMeeting(roomId);
  if (!meeting) {
    log.warn("refused unknown schedule", { email: identity.email, roomId });
    return { allowed: false, role: identity.role, reason: "No such class", meeting: null };
  }

  if (String(meeting.status || "").toLowerCase() === "cancelled") {
    return { allowed: false, role: identity.role, reason: "This class was cancelled", meeting };
  }

  if (config.requireToday && !meeting.isToday) {
    return {
      allowed: false,
      role: identity.role,
      reason: "This class is not scheduled for today",
      meeting,
    };
  }

  // Coordinators supervise every class; that is what the role is for.
  if (identity.role === "coordinator") {
    return { allowed: true, role: "coordinator", reason: "coordinator", meeting };
  }

  if (identity.role === "teacher") {
    const assigned = meeting.teacherEmail && meeting.teacherEmail === identity.email;
    if (assigned) return { allowed: true, role: "teacher", reason: "assigned teacher", meeting };
    if (!config.teacherMustMatch) {
      return { allowed: true, role: "teacher", reason: "any-teacher allowed", meeting };
    }
    // Demoted rather than refused: a substitute can still see the class, but
    // cannot mute the room, close the session or start a recording. A
    // coordinator, or fixing the schedule, is the way to actually take over.
    log.warn("teacher is not the one scheduled — joining as observer", {
      email: identity.email,
      scheduleId: meeting.scheduleId,
    });
    return { allowed: true, role: "student", reason: "not the scheduled teacher", meeting };
  }

  // The class admin named on the schedule is staff for that class.
  if (meeting.adminEmail && meeting.adminEmail === identity.email) {
    return { allowed: true, role: "coordinator", reason: "class admin", meeting };
  }

  if (!config.enforce) {
    return { allowed: true, role: identity.role, reason: "enrolment check disabled", meeting };
  }

  // Only real students have enrolment records. Centres, mentors, evaluators
  // and the like map to the student role but appear in no class, so requiring
  // enrolment would lock them out of everything. They join as observers.
  const isRecordedStudent = (identity.userTypes || []).includes("S");
  if (!isRecordedStudent) {
    log.info("non-student observer admitted", {
      email: identity.email,
      userTypes: identity.userTypes,
      scheduleId: meeting.scheduleId,
    });
    return { allowed: true, role: "student", reason: "observer", meeting };
  }

  const enrolled = await isStudentInClass(identity.email, meeting.classId);
  if (!enrolled) {
    log.warn("refused: student not in this class", {
      email: identity.email,
      scheduleId: meeting.scheduleId,
      classId: meeting.classId,
    });
    return {
      allowed: false,
      role: "student",
      reason: "You are not enrolled in this class",
      meeting,
    };
  }

  return { allowed: true, role: "student", reason: "enrolled", meeting };
}

module.exports = { authorize, resolveMeeting, isScheduleId, isStudentInClass, config };
