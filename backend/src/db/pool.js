/**
 * Read-only connection to the LYN platform database.
 *
 * This app owns no user records. Identity and authorisation are answered by
 * the same tables lynindia.in already uses, so a student removed there loses
 * meeting access here with no second system to update.
 *
 * The pool is created lazily: a developer running the meeting server without
 * DB credentials should get a clear error on the first auth attempt rather
 * than a crash at boot.
 */
const mysql = require("mysql2/promise");
const { createLogger } = require("../utils/logger");

const log = createLogger("DB");

let pool = null;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — the auth bridge cannot reach the user directory`);
  return value;
}

function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT || 3306),
    user: required("DB_USER"),
    password: required("DB_PASS"),
    database: required("DB_NAME"),
    waitForConnections: true,
    // Small on purpose. Auth does one short lookup per sign-in, not per frame,
    // and this server shares a database with the main site.
    connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
    connectTimeout: 10000,
    // Identity comparisons must not depend on the client's locale.
    charset: "utf8mb4_general_ci",
    timezone: "Z",
  });
  log.info("pool created", {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
  });
  return pool;
}

/** Parameterised query. Every caller passes values as bindings, never as SQL. */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function close() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/** Used by /health so a broken DB link is visible before a class starts. */
async function ping() {
  const rows = await query("SELECT 1 AS ok");
  return rows.length === 1;
}

module.exports = { getPool, query, close, ping };
