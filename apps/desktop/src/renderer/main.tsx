import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { StateProvider } from "./state/provider";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("renderer root element missing");

/**
 * Mounted immediately. Nothing is awaited before the first paint: the gateway
 * endpoint is a query (`state/queries.ts`) that the app reads as it resolves,
 * and the window is a usable navigator before the wire has answered.
 */
createRoot(root).render(
  <StrictMode>
    <StateProvider>
      <App />
    </StateProvider>
  </StrictMode>,
);
