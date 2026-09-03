import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: "src/main/index.ts" }, outDir: "dist/main" },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preloads must be CommonJS: Electron only loads ESM preloads with sandbox:false.
    build: {
      lib: { entry: "src/preload/index.ts", formats: ["cjs"] },
      rollupOptions: { output: { entryFileNames: "[name].cjs" } },
      outDir: "dist/preload",
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: { input: "src/renderer/index.html" },
      outDir: "dist/renderer",
      minify: "oxc",
    },
    plugins: [react({ compiler: true }), tailwindcss()],
  },
});
