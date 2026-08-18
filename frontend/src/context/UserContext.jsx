import React, { createContext, useContext, useMemo, useState } from "react";

const UserContext = createContext(null);

export function UserProvider({ children }) {
  const [session, setSession] = useState({
    name: "",
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
