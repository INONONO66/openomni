import { expect, jest, test } from "bun:test";
import { Machine } from "@openomni/protocol";
import { execute } from "../src/exec";

const request = { cmd: "while :; do :; done", cwd: "/" };

test("aborting an executing shell kills its process group and settles cancelled", async () => {
  const controller = new AbortController();
  const result = execute(request, controller.signal);
  controller.abort();
  expect(await result).toEqual({ status: "cancelled" });
  expect(await execute(request, controller.signal)).toEqual({ status: "cancelled" });
});

test("the execution deadline kills the real shell and settles timed_out", async () => {
  jest.useFakeTimers();
  try {
    const result = execute(request, new AbortController().signal);
    jest.advanceTimersByTime(Machine.EXEC_TIMEOUT_MS);
    expect(await result).toEqual({ status: "timed_out" });
  } finally {
    jest.useRealTimers();
  }
});
