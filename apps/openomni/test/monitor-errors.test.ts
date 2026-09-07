import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSource, pathSource } from "../src/composition/alarm-sources";
import { alarmPathEvent, alarmSummary } from "./helpers/alarm-payload";

test("alarm JSON boundary validates values instead of assigning a payload type", () => {
  expect(() =>
    alarmSummary('{"alarmId":"id","epoch":1,"reason":"exit","exitCode":"zero"}'),
  ).toThrow();
  expect(() =>
    alarmSummary('{"alarmId":"id","epoch":1,"reason":"invented","exitCode":0}'),
  ).toThrow();
  expect(() => alarmPathEvent('{"path":"/tmp/ready","event":"delete"}')).toThrow();
  expect(() => alarmPathEvent('{"path":42,"event":"create"}')).toThrow();
  expect(() => alarmSummary("not JSON")).toThrow();
});

test("PTY callback faults surface a typed boundary failure", async () => {
  const failed = Promise.withResolvers<Error>();
  const timer = setTimeout(() => failed.reject(new Error("PTY fault signal missing")), 5000);
  const source = commandSource(
    "printf 'LINE\\n'; read hold",
    () => {
      throw new Error("injected commit failure");
    },
    () => undefined,
    failed.resolve,
  );
  try {
    expect(await failed.promise).toMatchObject({ name: "AlarmSourceError", site: "pty.data" });
  } finally {
    clearTimeout(timer);
    await source.close();
  }
});

test("path callback faults report a typed failure without advancing its observation cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "monitor-path-error-"));
  const path = join(directory, "target");
  const errors: Error[] = [];
  let refuse = true;
  let delivered = 0;
  const source = pathSource(
    { path, event: "create", description: "commit failure", persistent: true },
    () => {
      if (refuse) throw new Error("injected path commit failure");
      delivered += 1;
    },
    (error) => errors.push(error),
  );
  try {
    writeFileSync(path, "created");
    source.observe?.();
    expect(errors).toMatchObject([{ name: "AlarmSourceError", site: "path.observe" }]);
    expect(delivered).toBe(0);
    refuse = false;
    source.observe?.();
    expect(delivered).toBe(1);
    source.observe?.();
    expect(delivered).toBe(1);
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
