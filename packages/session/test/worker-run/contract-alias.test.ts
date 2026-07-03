import { describe, expect, test } from "bun:test";
import type { WorkerRun } from "@openomni/protocol";
import type { WorkerRunStatus } from "../../src/index";

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type AssertExact<A, B> = IsExact<A, B> extends true ? true : never;

const workerRunStatusIsProtocolStatus: AssertExact<WorkerRunStatus, WorkerRun.Status> = true;

describe("WorkerRun public contracts", () => {
  test("WorkerRunStatus intentionally tracks the protocol WorkerRun.Status contract", () => {
    expect(workerRunStatusIsProtocolStatus).toBe(true);
  });
});
