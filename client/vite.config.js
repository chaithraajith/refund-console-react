import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite runs on :5173 and proxies /api to the Express server on :3000.
// In prod, `vite build` emits ./dist which Express serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
  build: { outDir: "dist" },
});
