import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { selectChatTransport } from "./chat/select-transport";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("renderer root element missing");
const reactRoot = createRoot(root);

/**
 * The endpoint is asked for BEFORE the first paint, and the app is mounted with
 * whichever transport the answer implies.
 *
 * Mounting first and swapping later would mean the chats built during the first
 * render are wired to the mock and keep it — `Chat` takes its transport at
 * construction — so the Owner would type into a fixture that looked exactly
 * like a live session. One await up front costs a frame and removes that class
 * of failure entirely.
 *
 * `window.desktop` is absent whenever this bundle runs outside Electron (the
 * screenshot script serves it from a plain HTTP server), and a preload that
 * failed to load is the same absence. Both land on the mock, which is what
 * `selectChatTransport` is handed `undefined` for.
 */
async function endpoint() {
  const bridge = (globalThis as { readonly desktop?: Window["desktop"] }).desktop;
  if (bridge === undefined) return undefined;
  try {
    return await bridge.gateway();
  } catch {
    // A failed `invoke` means the main process has no handler — an older shell
    // around a newer renderer. The mock is the honest surface for that: it is
    // labelled as a mock everywhere it appears, while a half-connected gateway
    // would look live and answer nothing.
    return undefined;
  }
}

// `transport` is `undefined` for the mock, which is how `App`'s own tuned mock
// stays in charge of the fixture surface.
const { transport } = selectChatTransport(await endpoint());

reactRoot.render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
