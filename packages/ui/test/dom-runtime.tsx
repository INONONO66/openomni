import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React DOM caches input-event support and its document at import time, so it
// must see the window it will render into. A desktop test file that ran earlier
// in the same process may have registered one already; a second window would
// leave React's cached document stale and swallow input events.
const owned = !GlobalRegistrator.isRegistered;
if (owned) GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const { act } = await import("react");
export const { createRoot } = await import("react-dom/client");
export const { Composer } = await import("../src/composer");
export const unregisterDom = () => (owned ? GlobalRegistrator.unregister() : Promise.resolve());
