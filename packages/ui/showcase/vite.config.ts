import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The showcase is a plain Vite app with no Electron dependency: the design
 * system has to be inspectable without booting a desktop shell, or it stops
 * being reviewed.
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
});
