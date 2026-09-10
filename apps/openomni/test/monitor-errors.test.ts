import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSource, pathSource } from "../src/composition/alarm-sources";
import { alarmPathEvent, alarmSummary } from "./helpers/alarm-payload";
import { eventSignal } from "./helpers/event-signal";

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
  const failed = eventSignal<Error>("PTY callback failure");
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
    await source.close();
  }
});

test("owned PTY drains the final UTF-8 line before reporting the child's exit status", async () => {
  const exited = eventSignal<number>("PTY drained exit");
  const close = spyOn(Bun.Terminal.prototype, "close");
  const lines: string[] = [];
  const source = commandSource(
    "printf '\\342\\230\\203 final'; exit 7",
    (line) => lines.push(line),
    exited.resolve,
    exited.reject,
  );
  try {
    expect(await exited.promise).toBe(7);
    expect(lines).toEqual(["\u2603 final"]);
    expect(close).toHaveBeenCalledTimes(1);
    await source.close();
    await source.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    try {
      await source.close();
    } finally {
      close.mockRestore();
    }
  }
});

test("PTY cancellation settles from a subscribed line signal without requiring natural EOF", async () => {
  const ready = eventSignal<string>("PTY ready");
  const errors: Error[] = [];
  const exits: number[] = [];
  const source = commandSource("printf 'READY\\n'; read hold", ready.resolve, (code) => exits.push(code), (error) => {
    errors.push(error);
    ready.reject(error);
  });
  try {
    expect(await ready.promise).toBe("READY");
    const closed = eventSignal<void>("PTY cancelled");
    void Promise.all([source.close(), source.close()]).then(() => closed.resolve(), closed.reject);
    await closed.promise;
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  } finally {
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
