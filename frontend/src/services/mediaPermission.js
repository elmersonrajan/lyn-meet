/**
 * What went wrong when the camera or microphone would not start, and what the
 * person can actually do about it.
 *
 * A browser that has been told "Block" will not ask again. Calling
 * getUserMedia a second time does not raise a prompt -- it is rejected
 * immediately, silently, for the life of that site permission. So "keep asking
 * until they allow it" cannot be done by asking: there is nobody listening.
 *
 * What can be done, and is:
 *
 *   - say what happened, in words that name the thing to click;
 *   - keep saying it until the device works, rather than for four seconds;
 *   - offer a retry, because a prompt that was DISMISSED rather than blocked
 *     will appear again, and that is a large share of the cases;
 *   - watch the permission itself, so that the moment somebody flips the
 *     switch in site settings the class starts without a reload.
 *
 * The messages name Chrome's wording because that is what the schools use. The
 * padlock is in the same place in every browser that matters.
 */

/**
 * @param {Error|null} err
 * @param {{wantCamera?: boolean}} opts
 * @returns {{kind: string, title: string, message: string, canRetry: boolean}|null}
 */
export function classifyMediaError(err, { wantCamera = false } = {}) {
  if (!err) return null;
  const name = err.name || "";
  const devices = wantCamera ? "camera and microphone" : "microphone";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      kind: "denied",
      title: `LYN MEET needs your ${devices}`,
      // Both halves on purpose: the first works if the prompt was dismissed,
      // the second if it was actually blocked, and the person cannot tell
      // which they did.
      message:
        `Choose Allow when the browser asks. If it does not ask, click the icon ` +
        `at the left of the address bar, set ${devices} to Allow, then press Try again.`,
      canRetry: true,
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      kind: "missing",
      title: `No ${devices} found`,
      message: `Plug one in, or check it is not switched off, then press Try again.`,
      canRetry: true,
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    // The commonest one after a denial, and the least obvious: another tab or
    // another application is holding the device.
    return {
      kind: "busy",
      title: `Something else is using your ${devices}`,
      message:
        `Close any other tab or app that may have it -- another meeting, a ` +
        `recorder, a camera app -- then press Try again.`,
      canRetry: true,
    };
  }

  if (name === "OverconstrainedError") {
    return {
      kind: "unsupported",
      title: `Your ${devices} cannot do what was asked`,
      message: `This is a setting on the server, not on your machine. Tell your coordinator.`,
      canRetry: true,
    };
  }

  if (name === "SecurityError") {
    return {
      kind: "insecure",
      title: "This page is not secure",
      // Nothing the person can do, so do not offer a button that cannot help.
      message: `A camera and microphone only work over https. Open the class from the link you were sent.`,
      canRetry: false,
    };
  }

  return {
    kind: "unknown",
    title: `Could not start your ${devices}`,
    message: `${err.message || "No reason was given."} Press Try again, or rejoin the class.`,
    canRetry: true,
  };
}

/**
 * Calls back when a device permission changes, so a class can start the moment
 * somebody allows it in site settings rather than when they think to reload.
 *
 * Returns a function that stops watching. Everything here is optional in some
 * browsers, and none of it is worth an exception: no Permissions API simply
 * means no automatic recovery, and the retry button still works.
 *
 * @param {string[]} names e.g. ["microphone", "camera"]
 * @param {() => void} onGranted
 * @param {object} nav the navigator, passed in so this can be tested without
 *   one -- globalThis.navigator is read-only in Node and not worth fighting.
 * @returns {() => void}
 */
export function watchPermissions(names, onGranted, nav = globalThis.navigator) {
  const stops = [];
  try {
    if (!nav?.permissions?.query) return () => {};
    for (const name of names) {
      nav.permissions
        .query({ name })
        .then((status) => {
          const handler = () => {
            if (status.state === "granted") onGranted();
          };
          status.addEventListener?.("change", handler);
          stops.push(() => status.removeEventListener?.("change", handler));
        })
        .catch(() => {
          // Firefox rejects for "camera"; not a problem worth reporting.
        });
    }
  } catch {
    /* no Permissions API at all */
  }
  return () => {
    for (const stop of stops) {
      try {
        stop();
      } catch {
        /* already gone */
      }
    }
  };
}
