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
      rollupOptions: {
        // `electron` is resolved by the RUNTIME, never bundled. Without this the
        // bundler follows the npm package's main field — which is the CLI shim
        // that returns a path to the binary — and inlines it, so `contextBridge`
        // and `ipcRenderer` resolve to `undefined` on a string. The preload then
        // throws before exposing anything and the renderer sees no bridge at
        // all, silently: nothing fails at build time, and the window still
        // opens. `externalizeDepsPlugin` does not cover it because `electron` is
        // a devDependency, which is where it belongs.
        external: ["electron"],
        output: { entryFileNames: "[name].cjs" },
      },
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
