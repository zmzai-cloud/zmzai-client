import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ["electron", "ws"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: "src/renderer/index.html",
      },
    },
    plugins: [react()],
  },
});
