import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import "./index.css";
import { installClientLogTee } from "./services/debugLog.js";

try {
  installClientLogTee();
  console.log("[Boot] mounting LYN MEET frontend");
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      {/*
        A render error used to unmount everything and leave white, which is
        reported as "the meeting is blank" and says nothing about what broke.
        This keeps the message on screen and offers the reload that rejoins.
      */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (err) {
  console.error("[Boot] failed to mount app", err);
}
