import React from "react";

function Svg({ children, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconVideo = (p) => (
  <Svg {...p}>
    <path d="M15 10.5 21.5 7v10L15 13.5" />
    <rect x="2.5" y="6" width="12.5" height="12" rx="2.5" />
  </Svg>
);

export const IconVideoOff = (p) => (
  <Svg {...p}>
    <path d="M15 10.5 21.5 7v10l-3.2-1.7" />
    <path d="M12.6 6H5a2.5 2.5 0 0 0-2.5 2.5V15.5A2.5 2.5 0 0 0 5 18h8a2.5 2.5 0 0 0 2.5-2.5v-2" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const IconMic = (p) => (
  <Svg {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </Svg>
);

export const IconMicOff = (p) => (
  <Svg {...p}>
    <path d="M15 5.5v-.2a3 3 0 0 0-6 0V11" />
    <path d="M18.5 11a6.5 6.5 0 0 1-9.9 5.6" />
    <path d="M5.5 11a6.5 6.5 0 0 0 1.2 3.8" />
    <path d="M12 17.5V21" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const IconMuteAll = (p) => (
  <Svg {...p}>
    <path d="M15.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H6a3.5 3.5 0 0 0-3.5 3.5V20" />
    <circle cx="9" cy="8" r="3.5" />
    <path d="M16.5 8.5h5" />
  </Svg>
);

export const IconRecord = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconStopRecord = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPoll = (p) => (
  <Svg {...p}>
    <path d="M6 19V11" />
    <path d="M12 19V5" />
    <path d="M18 19v-5.5" />
    <path d="M3 21h18" />
  </Svg>
);

export const IconChat = (p) => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H8l-4.5 2.5.9-4.2A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z" />
  </Svg>
);

export const IconLeave = (p) => (
  <Svg {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 8l-4 4 4 4" />
    <path d="M6 12h9" />
  </Svg>
);

export const IconEndSession = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9 9l6 6" />
    <path d="M15 9l-6 6" />
  </Svg>
);

export const IconPen = (p) => (
  <Svg {...p}>
    <path d="M16.8 3.7a2 2 0 0 1 2.8 2.8L7.5 18.6l-4 1.1 1.1-4Z" />
    <path d="M15 5.5 18.5 9" />
  </Svg>
);

export const IconEraser = (p) => (
  <Svg {...p}>
    <path d="M8.5 20.5H20" />
    <path d="M13.3 4.7a2 2 0 0 1 2.8 0l3.8 3.8a2 2 0 0 1 0 2.8l-7.4 7.4H7.9l-3.5-3.5a2 2 0 0 1 0-2.8Z" />
    <path d="M10.2 7.8 16.2 13.8" />
  </Svg>
);

export const IconTrash = (p) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </Svg>
);

export const IconScreen = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <path d="M8.5 20.5h7" />
    <path d="M12 16.5v4" />
  </Svg>
);

export const IconBoard = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M9 21l3-4 3 4" />
  </Svg>
);

export const IconClip = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="M10 9.5l5 2.5-5 2.5Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconClose = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconSend = (p) => (
  <Svg {...p}>
    <path d="M4 12l16-8-6 16-3.2-6.2Z" />
  </Svg>
);

export const IconCheck = (p) => (
  <Svg {...p}>
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </Svg>
);

export const IconClock = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconUsers = (p) => (
  <Svg {...p}>
    <path d="M14.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H6a3.5 3.5 0 0 0-3.5 3.5V20" />
    <circle cx="8.5" cy="8" r="3.5" />
    <path d="M21.5 20v-1.5a3.5 3.5 0 0 0-2.7-3.4" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
  </Svg>
);

export const IconChevronLeft = (p) => (
  <Svg {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Svg>
);

export const IconChevronRight = (p) => (
  <Svg {...p}>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </Svg>
);

export const IconLink = (p) => (
  <Svg {...p}>
    <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1.5 1.5" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1.5-1.5" />
  </Svg>
);

export const IconShuffle = (p) => (
  <Svg {...p}>
    <path d="M17 4.5L20.5 8 17 11.5" />
    <path d="M3.5 8h4.2a4 4 0 0 1 3.3 1.8l2 3a4 4 0 0 0 3.3 1.8h4.2" />
    <path d="M3.5 16h4.2a4 4 0 0 0 3.3-1.8" />
    <path d="M17 12.5l3.5 3.5L17 19.5" />
  </Svg>
);

export const IconHand = (p) => (
  <Svg {...p}>
    <path d="M8 11V5.5a1.75 1.75 0 0 1 3.5 0V11" />
    <path d="M11.5 10.5V4.25a1.75 1.75 0 0 1 3.5 0V11" />
    <path d="M15 11V6.5a1.75 1.75 0 0 1 3.5 0V14a7 7 0 0 1-7 7h-.5a7 7 0 0 1-7-7v-2a1.75 1.75 0 0 1 3.5 0" />
  </Svg>
);

export const IconHandLower = (p) => (
  <Svg {...p}>
    <path d="M8 11.5V7a1.75 1.75 0 0 1 3.5 0v4" />
    <path d="M11.5 11V6a1.75 1.75 0 0 1 3.5 0v5" />
    <path d="M15 11V8.5a1.75 1.75 0 0 1 3.5 0V14a7 7 0 0 1-7 7h-.5a7 7 0 0 1-7-7v-2a1.75 1.75 0 0 1 3.5 0" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const IconClipboard = (p) => (
  <Svg {...p}>
    <path d="M9 3.5h6v3H9z" />
    <path d="M15 5h2a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
    <path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" />
  </Svg>
);

export const IconDownload = (p) => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="M8 11l4 4 4-4" />
    <path d="M4.5 19.5h15" />
  </Svg>
);

export const IconRefresh = (p) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-2.6 5.9" />
    <path d="M20 4.5V11h-6" />
  </Svg>
);

export const IconUserMinus = (p) => (
  <Svg {...p} size={p?.size || 14}>
    <path d="M14.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H6a3.5 3.5 0 0 0-3.5 3.5V20" />
    <circle cx="8.5" cy="8" r="3.5" />
    <path d="M16 11h6" />
  </Svg>
);

export const IconThumbUp = (p) => (
  <Svg {...p}>
    <path d="M7 21V10l4.5-7a2 2 0 0 1 3.2 2.1L13 10h5.2a2.2 2.2 0 0 1 2.15 2.7l-1.6 6.5A2.5 2.5 0 0 1 16.3 21z" />
    <path d="M7 10H4.5A1.5 1.5 0 0 0 3 11.5v8A1.5 1.5 0 0 0 4.5 21H7" />
  </Svg>
);

export const IconThumbDown = (p) => (
  <Svg {...p}>
    <path d="M7 3v11l4.5 7a2 2 0 0 0 3.2-2.1L13 14h5.2a2.2 2.2 0 0 0 2.15-2.7l-1.6-6.5A2.5 2.5 0 0 0 16.3 3z" />
    <path d="M7 14H4.5A1.5 1.5 0 0 1 3 12.5v-8A1.5 1.5 0 0 1 4.5 3H7" />
  </Svg>
);
