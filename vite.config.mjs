import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "static/dist",
    rollupOptions: {
      input: {
        admin: "frontend/src/admin/main.js",
        participant: "frontend/src/participant/main.js",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
