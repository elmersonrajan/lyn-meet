import React, { createContext, useContext, useMemo, useState } from "react";

const UserContext = createContext(null);

export function UserProvider({ children }) {
  const [session, setSession] = useState({
    name: "",
    // The authenticated account, filled in from /auth/me. The browser cannot
    // set this to anything the server will believe -- it is here for display
    // and for the attendance panel, not as a credential.
    email: "",
    meetingId: "",
    role: "student",
    peer: null,
    joined: false,
  });

  const value = useMemo(
    () => ({
      session,
      setSession,
      isTeacher: session.role === "teacher",
      isCoordinator: session.role === "coordinator",
      isStaff: session.role === "teacher" || session.role === "coordinator",
      isStudent: session.role === "student",
    }),
    [session],
  );

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used inside UserProvider");
  return ctx;
}
