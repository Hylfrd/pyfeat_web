import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "static/dist",
    lib: {
      entry: "frontend/src/admin/main.js",
      name: "AdminApp",
      formats: ["iife"],
      fileName: () => "admin.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => (
          assetInfo.name && assetInfo.name.endsWith(".css")
            ? "admin.css"
            : "[name][extname]"
        ),
      },
    },
  },
});
