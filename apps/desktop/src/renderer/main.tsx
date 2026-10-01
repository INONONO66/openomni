import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type AppEnvironment } from "./app";
import { RendererInvariantError } from "./errors";
import { createPlatform } from "./platform";
import { bindStorePlatform } from "./state/store";
import { StateProvider } from "./state/provider";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new RendererInvariantError("renderer root element missing");

// The window has a tab strip, and the frame's `--shell-top` reads that fact
// from `<html>` before any component mounts (packages/ui/src/styles.css).
document.documentElement.dataset.tabStrip = "";

/** The one place the renderer touches the host clock and entropy (#1245). */
const host = createPlatform({ clock: Date, ids: crypto });
bindStorePlatform(host);

/** Read once at boot: where the OS draws its window controls, and the storage the shell remembers itself in. */
const environment: AppEnvironment = {
  platform: navigator.platform.startsWith("Mac") ? "darwin" : "other",
  storage: window.localStorage,
  host,
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
