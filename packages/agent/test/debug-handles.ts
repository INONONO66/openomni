import { afterAll } from "bun:test";

afterAll(() => {
  const handles = (process as any)._getActiveHandles?.() ?? [];
  const requests = (process as any)._getActiveRequests?.() ?? [];
  console.log(
    "[DEBUG] Active handles:",
    handles.map((h: any) => h?.constructor?.name ?? typeof h),
  );
  console.log(
    "[DEBUG] Active requests:",
    requests.map((r: any) => r?.constructor?.name ?? typeof r),
  );
  if (handles.length > 0) {
    console.log("[DEBUG] Force exiting in 3s...");
    setTimeout(() => process.exit(0), 3000).unref();
  }
});
