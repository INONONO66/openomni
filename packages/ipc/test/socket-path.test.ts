import { expect, test } from "bun:test";
import { z } from "zod";

const FixtureModule = z.object({
  socketPath: z.custom<(label: string) => string>((value) => typeof value === "function"),
});

test("fresh IPC fixture scopes cannot reuse a stale process-id socket path", async () => {
  const first = await import(
    new URL("./helpers/socket-path.ts?first", import.meta.url).href
  ).then(FixtureModule.parse);
  const restarted = await import(
    new URL("./helpers/socket-path.ts?restarted", import.meta.url).href
  ).then(FixtureModule.parse);
  const path = first.socketPath("reused-pid");
  const next = restarted.socketPath("reused-pid");
  expect(next).not.toBe(path);
  expect(Buffer.byteLength(next)).toBeLessThan(104);
});
