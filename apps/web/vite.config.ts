import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

// In local dev the API runs on :3000; proxy /api and /ws there so the
// frontend can use same-origin relative URLs. In a built deployment the API
// base comes from VITE_API_URL instead (see src/api.ts).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the shared types package straight to source — it is types
      // only, so there is nothing to build.
      "@vj/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
