function stamp() {
  return new Date().toISOString();
}

function safe(value) {
  try {
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack, name: value.name };
    }
    return value;
  } catch (err) {
    return String(value);
  }
}

function fmt(scope, level, args) {
  return [`[${stamp()}] [${scope}] [${level}]`, ...args.map(safe)];
}

function createLogger(scope) {
  return {
    info(...args) {
      try { console.log(...fmt(scope, "INFO", args)); }
      catch (err) { console.error("[Logger] info failed", err); }
    },
    warn(...args) {
      try { console.warn(...fmt(scope, "WARN", args)); }
      catch (err) { console.error("[Logger] warn failed", err); }
    },
    error(...args) {
      try { console.error(...fmt(scope, "ERROR", args)); }
      catch (err) { console.error("[Logger] error failed", err); }
    },
    action(name, extra) {
      try { console.log(...fmt(scope, "ACTION", [name, extra || {}])); }
      catch (err) { console.error("[Logger] action failed", err); }
    },
  };
}

function wrapAck(log, callback) {
  return (payload) => {
    try {
      if (typeof callback !== "function") {
        log.warn("socket callback missing", payload);
        return;
      }
      callback(payload);
    } catch (err) {
      log.error("socket callback throw", err);
    }
  };
}

function splitPayload(payload, callback) {
  if (typeof payload === "function") return { payload: {}, callback: payload };
  return { payload: payload || {}, callback };
}

module.exports = { createLogger, wrapAck, splitPayload };
