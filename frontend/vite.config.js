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
      ? {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
        }
      : false,
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/socket.io": {
        target: "http://127.0.0.1:5000",
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:5000",
      },
      "/recordings": {
        target: "http://127.0.0.1:5000",
      },
      "/health": {
        target: "http://127.0.0.1:5000",
      },
    },
  },
});