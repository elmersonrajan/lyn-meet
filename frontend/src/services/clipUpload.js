/**
 * Sending a video to the server so the class can watch it.
 *
 * Written with XMLHttpRequest rather than fetch for one reason: fetch cannot
 * report upload progress. A teacher who picks a 200 MB file and gets no
 * feedback for forty seconds has every reason to conclude the feature is
 * broken, and that is a worse failure than an error message.
 *
 * The other half of the job is saying what went wrong. An upload can be
 * refused by something that is not this application at all -- a reverse proxy
 * with a body-size limit answers in HTML, not JSON -- so nothing here assumes
 * the response is a shape we recognise.
 */

/** Matches the server's own default. A file over this is refused before it is sent. */
export const MAX_CLIP_MB = Number(import.meta.env?.VITE_MAX_CLIP_MB) || 300;

/** What a browser will play. The server keeps its own copy of this list. */
const PLAYABLE = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-matroska",
]);

export function describeFile(file) {
  const megabytes = file.size / (1024 * 1024);
  const type = String(file.type || "").toLowerCase();

  if (!file.size) return "That file is empty";
  if (megabytes > MAX_CLIP_MB) {
    return `That video is ${Math.round(megabytes)} MB. The limit is ${MAX_CLIP_MB} MB.`;
  }
  // An empty type is what some systems report for a perfectly ordinary .mp4,
  // so it is allowed through and the server decides.
  if (type && !PLAYABLE.has(type)) {
    return `${type} cannot be played in a browser. Use MP4, WebM or MOV.`;
  }
  return null;
}

/**
 * Turns a failed upload into a sentence a teacher can act on.
 *
 * The status matters more than the body here: 413 in particular comes from
 * whatever sits in front of this server, carries no JSON, and means something
 * quite specific that no amount of retrying will fix.
 */
function describeFailure(status, body) {
  if (status === 413) {
    return `The server refused that file as too large. Its upload limit may be lower than ${MAX_CLIP_MB} MB.`;
  }
  if (status === 401) return "Your sign-in has expired. Reload the page and sign in again.";
  if (status === 403) return "Only a teacher or coordinator can play a video to the class";
  if (body?.error) return body.error;
  if (status === 0) return "The upload did not reach the server";
  return `The upload failed (HTTP ${status})`;
}

/**
 * @param {File} file
 * @param {{ meetingId: string, onProgress?: (percent: number) => void }} opts
 * @returns {Promise<{ src: string, name: string }>}
 */
export function uploadClip(file, { meetingId, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/clips");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
    xhr.setRequestHeader("X-Meeting-Id", String(meetingId || ""));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A proxy refusing the request answers in HTML. Not an error in itself.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok) {
        resolve(body);
        return;
      }
      console.error("[clipUpload] failed", { status: xhr.status, body: xhr.responseText?.slice(0, 200) });
      reject(new Error(describeFailure(xhr.status, body)));
    };

    xhr.onerror = () => {
      console.error("[clipUpload] network error");
      reject(new Error("The upload did not reach the server"));
    };
    xhr.onabort = () => reject(new Error("The upload was cancelled"));

    xhr.send(file);
  });
}
