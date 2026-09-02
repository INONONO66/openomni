import { describe, expect, test } from "bun:test";
import type { Delegation } from "@openomni/protocol";
import type { DelegationOrigin } from "../src/delegation/admission";
import { formatSettlement, type DelegationKernel } from "../src/delegation/kernel";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

const ORIGIN: DelegationOrigin = { role: "resident", depth: 0, sessionId: "session" };

const delegate = (delegation: DelegationKernel, origin: DelegationOrigin) =>
  modelToolOutput("delegate", { delegation }, origin);
const awaitDelegation = (delegation: DelegationKernel) =>
  modelToolOutput("await_delegation", { delegation }, ORIGIN);
const cancelDelegation = (delegation: DelegationKernel) =>
  modelToolOutput("cancel_delegation", { delegation }, ORIGIN);
const HANDLE: Delegation.Handle = {
  delegationId: "d-1",
  operation: "ask",
  address: { kind: "core", scope: "independent" },
  transport: "process",
  deadline: 100,
  rootDelegationId: "d-1",
};

function kernel(overrides: Partial<DelegationKernel>): DelegationKernel {
  return {
    now: () => 0,
    delegate: () => Promise.resolve({ handle: HANDLE }),
    awaitDelegation: () => Promise.resolve({ kind: "timeout", delegationId: "d-1", deadline: 100 }),
    cancelDelegation: () =>
      Promise.resolve({ status: "cancelled", delegationId: "d-1", reason: "cancelled", at: 1 }),
    await: () => Promise.resolve({ kind: "timeout", delegationId: "d-1", deadline: 100 }),
    cancel: () =>
      Promise.resolve({ status: "cancelled", delegationId: "d-1", reason: "cancelled", at: 1 }),
    settleFromReply: () => false,
    start: () => undefined,
    stop: () => undefined,
    ...overrides,
  };
}

const valid = {
  instruction: "work",
  operation: "ask",
  scope: "independent",
  timeoutMs: 10,
} as const;

describe("delegation tool boundaries", () => {
  test("rejects every invalid addressing and operation combination before the kernel", async () => {
    let calls = 0;
    const execute = dispatchModelTool(
      "delegate",
      {
        delegation: kernel({
          delegate: () => {
            calls += 1;
            return Promise.resolve({ handle: HANDLE });
          },
        }),
      },
      ORIGIN,
    );
    const invalid = [
      null,
      { ...valid, scope: undefined },
      { ...valid, actorId: "actor" },
      { ...valid, operation: "notify" },
      { ...valid, operation: "assign", scope: "inline", acceptanceCriteria: ["done"] },
      { ...valid, operation: "assign" },
      { ...valid, acceptanceCriteria: ["not allowed"] },
    ];

    for (const input of invalid) {
      expect(await execute(input)).toMatchObject({ isError: true, errorClass: "invalid_input" });
    }
    expect(calls).toBe(0);
  });

  test("supports the legacy mode boundary and every kernel result arm", async () => {
    let request: unknown;
    const accepted = delegate(
      kernel({
        delegate: (candidate) => {
          request = candidate;
          return Promise.resolve({ handle: { ...HANDLE, waitId: "wait-1" } });
        },
      }),
      ORIGIN,
    );
    expect(
      await accepted({ instruction: "work", mode: "ask", scope: "independent", timeoutMs: 10 }),
    ).toBeString();
    expect(request).toMatchObject({ operation: "ask", deadline: 10 });

    const refused = delegate(
      kernel({
        delegate: () => Promise.resolve({ refused: "no", error: new Error("no") as never }),
      }),
      ORIGIN,
    );
    expect(await refused(valid)).toBeString();

    const settled = delegate(
      kernel({
        delegate: () =>
          Promise.resolve({
            handle: HANDLE,
            settled: { status: "completed", delegationId: "d-1", output: "done", at: 1 },
          }),
      }),
      ORIGIN,
    );
    expect(await settled(valid)).toBe("done");
  });

  test("renders structured, ordinary, and primitive refusals", async () => {
    for (const error of [{ data: { message: "structured" } }, new Error("ordinary"), "primitive"]) {
      const execute = delegate(kernel({ delegate: () => Promise.reject(error) }), ORIGIN);
      expect(await execute(valid)).toBeString();
    }
  });

  test("await and cancel cover malformed, timeout, settlement, and failure results", async () => {
    expect(await awaitDelegation(kernel({}))({})).toBeString();
    expect(await awaitDelegation(kernel({}))({ delegationId: "d-1", timeoutMs: 1 })).toBeString();
    expect(
      await awaitDelegation(
        kernel({
          awaitDelegation: () =>
            Promise.resolve({
              kind: "settled",
              settlement: { status: "completed", delegationId: "d-1", output: "done", at: 1 },
            }),
        }),
      )({ delegationId: "d-1" }),
    ).toBe("done");
    expect(
      await awaitDelegation(
        kernel({ awaitDelegation: () => Promise.reject({ data: { message: "no" } }) }),
      )({ delegationId: "d-1" }),
    ).toBeString();

    expect(await cancelDelegation(kernel({}))({})).toBeString();
    expect(await cancelDelegation(kernel({}))({ delegationId: "d-1" })).toBeString();
    expect(
      await cancelDelegation(kernel({ cancelDelegation: () => Promise.reject(new Error("no")) }))({
        delegationId: "d-1",
      }),
    ).toBeString();
  });

  test("formats every durable settlement status", () => {
    const settlements: Delegation.Settled[] = [
      { status: "completed", delegationId: "d", output: "", at: 1 },
      { status: "failed", delegationId: "d", error: "x", at: 1 },
      { status: "cancelled", delegationId: "d", reason: "x", at: 1 },
      { status: "delivery_failed", delegationId: "d", reason: "x", at: 1 },
      { status: "no_response", delegationId: "d", deadline: 1, at: 1 },
      { status: "interrupted", delegationId: "d", at: 1 },
      { status: "sent", delegationId: "d", at: 1 },
    ];
    expect(settlements.map(formatSettlement)).toHaveLength(settlements.length);
  });

  test("#807: an assign carries its verification declaration through to the kernel", async () => {
    let request: unknown;
    const execute = delegate(
      kernel({
        delegate: (candidate) => {
          request = candidate;
          return Promise.resolve({ handle: HANDLE });
        },
      }),
      ORIGIN,
    );
    const verification = {
      kind: "command.v1",
      executable: { id: "bun" },
      argv: ["test", "packages/ledger"],
      timeoutMs: 60_000,
      expectations: [{ criterionIndex: 0, exitCode: 0 }],
    };

    await execute({
      instruction: "fix the flaky test",
      operation: "assign",
      scope: "independent",
      acceptanceCriteria: ["bun test packages/ledger green"],
      verification,
      timeoutMs: 10,
    });

    expect(request).toMatchObject({ operation: "assign", verification });
  });

  test("#807: a declaration is refused for ask, and for a malformed executable id", async () => {
    let calls = 0;
    const execute = delegate(
      kernel({
        delegate: () => {
          calls += 1;
          return Promise.resolve({ handle: HANDLE });
        },
      }),
      ORIGIN,
    );
    const declaration = {
      kind: "command.v1",
      executable: { id: "bun" },
      argv: [],
      timeoutMs: 1_000,
      expectations: [{ criterionIndex: 0, exitCode: 0 }],
    };

    expect(await execute({ ...valid, verification: declaration })).toContain(
      "ask carries no verification declaration",
    );
    expect(
      await execute({
        ...valid,
        operation: "assign",
        acceptanceCriteria: ["done"],
        verification: { ...declaration, executable: { id: "/usr/bin/bun" } },
      }),
    ).toBeString();
    expect(
      await execute({
        ...valid,
        operation: "assign",
        acceptanceCriteria: ["done"],
        verification: { ...declaration, shell: "bun test" },
      }),
    ).toBeString();
    expect(calls).toBe(0);
  });
});
