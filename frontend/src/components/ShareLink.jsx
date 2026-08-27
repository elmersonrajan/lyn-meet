import React, { useCallback, useEffect, useRef, useState } from "react";
import { buildMeetingLink, copyText } from "../services/meetingLink.js";
import { IconLink, IconCheck } from "./Icons.jsx";

/**
 * Copy-the-invite-link button.
 *
 * @param {{ meetingId: string, variant?: "full"|"compact", onCopied?: (msg:string)=>void }} props
 * variant "full" also shows the link text; "compact" is just the button.
 */
export default function ShareLink({ meetingId, variant = "full", onCopied }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const link = buildMeetingLink(meetingId);

  const copy = useCallback(async () => {
    const ok = await copyText(link);
    if (!ok) {
      onCopied?.("Could not copy — select the link and copy it manually");
      return;
    }
    setCopied(true);
    onCopied?.("Invite link copied");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [link, onCopied]);

  if (!link) return null;

  return (
    <div className={`share-link ${variant}`}>
      {variant === "full" ? (
        // Readable and selectable, so the link can still be copied by hand if
        // the browser blocks clipboard access.
        <input className="share-url" value={link} readOnly onFocus={(e) => e.target.select()} />
      ) : null}
      <button
        type="button"
        className={`share-btn ${copied ? "done" : ""}`}
        onClick={copy}
        title="Copy the invite link"
      >
        {copied ? <IconCheck size={15} /> : <IconLink size={15} />}
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
