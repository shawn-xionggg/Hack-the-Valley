import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Two pages: the vision dev page (calibration, go/no-go) and Person 3's React dashboard.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        dashboard: resolve(import.meta.dirname, "dashboard.html"),
      },
    },
  },
});
