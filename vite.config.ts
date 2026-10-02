import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/test-project/" : "/",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 1455,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:1456",
      "/auth": "http://127.0.0.1:1456",
    },
  },
}));
