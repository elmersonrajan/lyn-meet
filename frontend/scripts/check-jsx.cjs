#!/usr/bin/env node
/**
 * Parses every .js/.jsx file under src/ and reports syntax errors.
 *
 * Exists because a duplicate export once took the whole app down at runtime:
 * the module failed to parse, so the first sign of trouble was a blank page.
 * This catches that class of fault before the app is loaded.
 *
 * Uses @babel/parser directly -- it ships with @babel/core (a Vite dependency),
 * needs no preset, and is pure JavaScript, so it also runs on a machine whose
 * node_modules was installed for a different platform.
 *
 * Catches: syntax errors, unterminated JSX, and redeclared identifiers.
 * Does NOT catch: unresolved imports, undefined variables, or anything at
 * runtime. It is a parse check, not a type check.
 */
const fs = require("fs");
const path = require("path");

let parser;
try {
  parser = require("@babel/parser");
} catch {
  console.error("check-jsx: @babel/parser not found. Run npm install first.");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..", "src");
const SKIP = new Set(["node_modules", "dist", ".git"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`check-jsx: no src directory at ${ROOT}`);
    process.exit(2);
  }

  const files = walk(ROOT);
  const failures = [];

  for (const file of files) {
    try {
      parser.parse(fs.readFileSync(file, "utf8"), {
        sourceType: "module",
        plugins: ["jsx"],
      });
    } catch (err) {
      failures.push({ file: path.relative(ROOT, file), message: err.message });
    }
  }

  if (failures.length) {
    console.error(`\ncheck-jsx: ${failures.length} of ${files.length} file(s) failed to parse\n`);
    for (const f of failures) console.error(`  ${f.file}\n    ${f.message}\n`);
    process.exit(1);
  }

  console.log(`check-jsx: ${files.length} files parsed OK`);
}

main();
