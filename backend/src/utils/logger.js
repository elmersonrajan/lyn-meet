function stamp() {
  return new Date().toISOString();
}

function fmt(scope, level, args) {
  return [`[${stamp()}] [${scope}] [${level}]`, ...args];
}

function createLogger(scope) {
  return {
    info(...args) {
      try {
        console.log(...fmt(scope, "INFO", args));
      } catch (err) {
        console.error("[Logger] failed to write info log", err);
      }
    },
    warn(...args) {
      try {
        console.warn(...fmt(scope, "WARN", args));
      } catch (err) {
        console.error("[Logger] failed to write warn log", err);
      }
    },
    error(...args) {
      try {
        console.error(...fmt(scope, "ERROR", args));
      } catch (err) {
        console.error("[Logger] failed to write error log", err);
      }
    },
    action(name, extra) {
      try {
        console.log(...fmt(scope, "ACTION", [name, extra || {}]));
      } catch (err) {
        console.error("[Logger] failed to write action log", err);
      }
    },
  };
}

module.exports = { createLogger };
