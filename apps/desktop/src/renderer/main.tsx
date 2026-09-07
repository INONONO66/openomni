import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type AppEnvironment } from "./app";
import { StateProvider } from "./state/provider";
import "./styles.css";

// Dev-only DOM-to-source inspector (https://react-grep.com); never in the production bundle.
if (import.meta.env.DEV) void import("react-grep");

const root = document.getElementById("root");
if (!root) throw new Error("renderer root element missing");

// The window has a tab strip, and the frame's `--shell-top` reads that fact
// from `<html>` before any component mounts (packages/ui/src/styles.css).
document.documentElement.dataset.tabStrip = "";

/** Read once at boot: where the OS draws its window controls, and the storage the shell remembers itself in. */
const environment: AppEnvironment = {
  platform: navigator.platform.startsWith("Mac") ? "darwin" : "other",
  storage: window.localStorage,
};

/**
 * Mounted immediately. Nothing is awaited before the first paint: the gateway
 * endpoint is a query (`state/queries.ts`) that the app reads as it resolves,
 * and the window is a usable navigator before the wire has answered.
 */
createRoot(root).render(
  <StrictMode>
    <StateProvider>
      <App {...environment} />
    </StateProvider>
  </StrictMode>,
);
