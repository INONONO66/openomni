import { expect, spyOn, test } from "bun:test";
import { runScriptMain } from "./main-runner";

function capture() {
  const stderr: string[] = [];
  const exits: number[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stderr, exits, exit: (code: number) => exits.push(code), restore: () => write.mockRestore() };
}

test("a clean main runs once and neither exits nor writes to stderr", async () => {
  let runs = 0;
  const io = capture();
  try {
    await runScriptMain(async () => {
      runs += 1;
    }, io.exit);
  } finally {
    io.restore();
  }
  expect(runs).toBe(1);
  expect(io.exits).toEqual([]);
  expect(io.stderr).toEqual([]);
});

test("a throwing main prints ERROR with the message and exits 1", async () => {
  const io = capture();
  try {
    await runScriptMain(() => Promise.reject(new Error("gate broke")), io.exit);
  } finally {
    io.restore();
  }
  expect(io.exits).toEqual([1]);
  expect(io.stderr).toEqual(["ERROR: gate broke\n"]);
});

test("a non-Error rejection is stringified, not swallowed", async () => {
  const io = capture();
  try {
    await runScriptMain(() => Promise.reject("plain reason"), io.exit);
  } finally {
    io.restore();
  }
  expect(io.exits).toEqual([1]);
  expect(io.stderr).toEqual(["ERROR: plain reason\n"]);
});

test("a synchronously throwing main is caught like a rejection", async () => {
  const io = capture();
  try {
    await runScriptMain(() => {
      throw new Error("sync gate broke");
    }, io.exit);
  } finally {
    io.restore();
  }
  expect(io.exits).toEqual([1]);
  expect(io.stderr).toEqual(["ERROR: sync gate broke\n"]);
});
