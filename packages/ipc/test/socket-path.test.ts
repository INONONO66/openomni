import { expect, test } from "bun:test";

test("fresh IPC fixture scopes cannot reuse a stale process-id socket path", async () => {
  const first: typeof import("./helpers/socket-path") = await import(
    new URL("./helpers/socket-path.ts?first", import.meta.url).href
  );
  const restarted: typeof import("./helpers/socket-path") = await import(
    new URL("./helpers/socket-path.ts?restarted", import.meta.url).href
  );
  const path = first.socketPath("reused-pid");
  const next = restarted.socketPath("reused-pid");
  expect(next).not.toBe(path);
  expect(Buffer.byteLength(next)).toBeLessThan(104);
});
