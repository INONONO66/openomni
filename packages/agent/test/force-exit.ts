// Force exit after 10s if bun test hangs (bun 1.3.6 Linux event loop bug)
const forceExitTimer = setTimeout(() => {
  const handles = (process as any)._getActiveHandles?.() ?? [];
  console.log(
    "[DEBUG] Force exit triggered. Active handles:",
    handles.map((h: any) => `${h?.constructor?.name ?? typeof h}`),
  );
  process.exit(process.exitCode ?? 0);
}, 10_000);
forceExitTimer.unref();
