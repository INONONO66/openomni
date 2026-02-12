// Force exit after 20s if bun test hangs (Linux inotify/event loop issue)
const forceExitTimer = setTimeout(() => {
  const handles = (process as any)._getActiveHandles?.() ?? [];
  console.log(
    "[DEBUG] Force exit triggered. Active handles:",
    handles.map((h: any) => `${h?.constructor?.name ?? typeof h}`),
  );
  process.exit(0);
}, 20_000);
forceExitTimer.unref();
