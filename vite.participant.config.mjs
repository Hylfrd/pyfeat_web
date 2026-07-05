import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    outDir: "static/dist",
    lib: {
      entry: "frontend/src/participant/main.js",
      name: "ParticipantApp",
      formats: ["iife"],
      fileName: () => "participant.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => (
          assetInfo.name && assetInfo.name.endsWith(".css")
            ? "participant.css"
            : "[name][extname]"
        ),
      },
    },
  },
});
