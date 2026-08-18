import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

try {
  console.log("[Boot] mounting Classroom Meet frontend");
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (err) {
  console.error("[Boot] failed to mount app", err);
}
