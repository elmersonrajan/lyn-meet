import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
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
