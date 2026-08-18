import React, { useState } from "react";
import { UserProvider } from "./context/UserContext.jsx";
import MeetingLobby from "./components/MeetingLobby.jsx";
import MeetingRoom from "./components/MeetingRoom.jsx";
import { getSocket } from "./services/socket.js";

function Shell() {
  const [joined, setJoined] = useState(false);
  const [joinPayload, setJoinPayload] = useState(null);

  return joined && joinPayload ? (
    <MeetingRoom
      socket={getSocket()}
      joinPayload={joinPayload}
      onLeft={() => {
        setJoined(false);
        setJoinPayload(null);
      }}
    />
  ) : (
    <MeetingLobby
      onJoined={() => setJoined(true)}
      onJoinPayload={setJoinPayload}
    />
  );
}

export default function App() {
  return (
    <UserProvider>
      <div className="app-shell">
        <Shell />
      </div>
    </UserProvider>
  );
}
