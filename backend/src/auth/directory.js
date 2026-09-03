/**
 * The authorisation oracle.
 *
 * `v_Users` is the platform's own answer to "is this a real member of the
 * organisation, and what are they?" -- it unions Students, Users,
 * LearningCentres, Teachers, Mentors, ClassAdmins and today's StudentException
 * rows into (emailid, UserType). Reusing it means this app can never drift
 * from lynindia.in's idea of who exists.
 *
 * Nothing here trusts anything the browser said. The SSO ticket names an email
 * and this module decides, from the database, whether that email may enter and
 * with what powers. A ticket for a deleted student is a ticket for nobody.
 */
const { query } = require("../db/pool");
const { createLogger } = require("../utils/logger");

const log = createLogger("Directory");

/**
 * Platform UserType -> meeting role.
 *
 * The mapping is the organisation's, not ours: A/Q/O coordinate, S/M/C are
 * students, T teaches. Management (M) sits in the student row deliberately --
 * they attend classes, they do not run them, and coordinator carries real
 * powers here (mute anyone, close the session, export the register).
 *
 * Unknown or newly added codes fall through to student rather than being
 * denied: they are members of the organisation, and the safe failure is fewer
 * powers, not a locked door.
 */
const ROLE_BY_USERTYPE = {
  T: "teacher",
  A: "coordinator", // Administrator
  Q: "coordinator", // Academic Coordinators
  O: "coordinator", // Online Admins
  S: "student", // Student
  M: "student", // Management
  C: "student", // Centre
};

function roleFor(userType) {
  return ROLE_BY_USERTYPE[String(userType || "").trim().toUpperCase()] || "student";
}

/** Emails are compared case-insensitively and trimmed, as the platform stores them inconsistently. */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Resolves an email to an authorised identity, or null if the person is not a
 * current member of the organisation.
 *
 * A single email can appear more than once in `v_Users` (a teacher who is also
 * a class admin). Every matching row is collected and the strongest role wins,
 * so a dual-role person is not silently demoted to student by row order.
 */
async function lookup(email) {
  const emailid = normalizeEmail(email);
  if (!emailid || !emailid.includes("@")) return null;

  const rows = await query(
    `SELECT UserType FROM v_Users WHERE LOWER(TRIM(emailid)) = ?`,
    [emailid],
  );
  if (!rows.length) return null;

  const userTypes = rows.map((r) => String(r.UserType || "").trim().toUpperCase());
  const roles = userTypes.map(roleFor);
  const role = roles.includes("teacher")
    ? "teacher"
    : roles.includes("coordinator")
      ? "coordinator"
      : "student";

  const displayName = await displayNameFor(emailid, role);

  return { email: emailid, role, userTypes, name: displayName };
}

/**
 * A human-readable name for the participant tile.
 *
 * The platform keeps names in a different table per population, so this asks
 * the one that matches the resolved role and falls back to the local part of
 * the address. A missing name must never block entry -- it is a label, not a
 * credential.
 */
async function displayNameFor(emailid, role) {
  try {
    if (role === "teacher") {
      const rows = await query(
        `SELECT FullName AS n FROM Teachers WHERE LOWER(TRIM(TeacherEmail)) = ? LIMIT 1`,
        [emailid],
      );
      if (rows[0]?.n) return String(rows[0].n).trim();
    }
    if (role === "coordinator") {
      const rows = await query(
        `SELECT CONCAT_WS(' ', AdminFirstName, AdminLastName) AS n
           FROM ClassAdmins WHERE LOWER(TRIM(AdminEmail)) = ? LIMIT 1`,
        [emailid],
      );
      if (rows[0]?.n && String(rows[0].n).trim()) return String(rows[0].n).trim();
    }
    const rows = await query(
      `SELECT CONCAT_WS(' ', FirstName, LastName) AS n
         FROM Students WHERE LOWER(TRIM(emailid)) = ? LIMIT 1`,
      [emailid],
    );
    if (rows[0]?.n && String(rows[0].n).trim()) return String(rows[0].n).trim();
  } catch (err) {
    log.error("displayName lookup failed — falling back to the address", err.message);
  }
  return emailid.split("@")[0];
}

module.exports = { lookup, roleFor, normalizeEmail, ROLE_BY_USERTYPE };
