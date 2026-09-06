import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

const keyPath = path.resolve(__dirname, "key.pem");
const certPath = path.resolve(__dirname, "cert.pem");
const hasCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);

export default defineConfig({
  plugins: [react()],
  server: {
    https: hasCerts
      ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
      : false,
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/socket.io": { target: "http://127.0.0.1:5000", ws: true, changeOrigin: true },
      "/api": { target: "http://127.0.0.1:5000" },
      // Sign-in. Same trap as /.well-known below: without an entry here Vite
      // answers /auth/me and /auth/handoff with index.html, so the SPA gets a
      // page where it expected JSON and every sign-in fails. In production
      // nginx forwards everything to this dev server rather than routing
      // /api itself, so this list -- not the nginx config -- is what decides
      // whether a path reaches the backend at all.
      "/auth": { target: "http://127.0.0.1:5000" },
      "/recordings": { target: "http://127.0.0.1:5000" },
      "/health": { target: "http://127.0.0.1:5000" },
      // Domain ownership proof for the mobile apps. Without this the SPA
      // answers it with index.html, Android's check fails silently, and every
      // shared link opens a browser instead of the app.
      "/.well-known": { target: "http://127.0.0.1:5000" },
    },
  },
});
