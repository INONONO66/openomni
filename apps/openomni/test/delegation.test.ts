import { describe, expect, test } from "bun:test";
import { admit, type DelegationOrigin } from "../src/delegation/admission";
import { createInlineDriver } from "../src/delegation/inline-driver";
import { createDelegationKernel, type DelegationDriver } from "../src/delegation/kernel";
import { DELEGATE_TOOL_NAME, delegateToolExecutor, delegateToolSpec } from "../src/delegation/tool";

const RESIDENT: DelegationOrigin = { role: "resident", depth: 0, sessionId: "session-origin" };
const WORKER: DelegationOrigin = { role: "worker", depth: 1, sessionId: "session-origin" };
const LIMITS = { maxInlineDepth: 2 };

function ask(overrides: Record<string, unknown> = {}) {
  return {
    address: { kind: "core", scope: "inline" },
    mode: "ask",
    payload: { text: "what is the state of the build" },
    deadline: 10_000,
    ...overrides,
  };
}

function kernelWith(driver: DelegationDriver, transport: "inline" | "process" = "inline") {
  let issued = 0;
  return createDelegationKernel({
    drivers: { [transport]: driver },
    now: () => 1000,
    newDelegationId: () => `d-${++issued}`,
    limits: LIMITS,
  });
}

describe("admission", () => {
  test("a worker may open an inline child but may not commission independent work", () => {
    const inline = admit(ask(), WORKER, 1000, LIMITS);
    expect(inline.ok).toBe(true);

    const independent = admit(
      ask({ address: { kind: "core", scope: "independent" }, mode: "assign", acceptanceCriteria: ["done"] }),
      WORKER,
      1000,
      LIMITS,
    );
    expect(independent).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ask the Resident for independent work"),
    });
  });

  test("inline chains stop at the configured depth instead of running away", () => {
    const atCap = admit(ask(), { role: "worker", depth: 2, sessionId: "session-origin" }, 1000, LIMITS);
    expect(atCap).toMatchObject({ ok: false, reason: "inline delegation is capped at depth 2" });
  });

  test("a deadline already in the past is refused, not silently extended", () => {
    expect(admit(ask({ deadline: 900 }), RESIDENT, 1000, LIMITS)).toMatchObject({
      ok: false,
      reason: "deadline has already passed",
    });
  });

  test("an address says who, and admission alone turns that into a wire", () => {
    expect(admit(ask(), RESIDENT, 1000, LIMITS)).toMatchObject({ ok: true, transport: "inline" });
    expect(
      admit(
        ask({ address: { kind: "core", scope: "independent" }, mode: "assign", acceptanceCriteria: ["done"] }),
        RESIDENT,
        1000,
        LIMITS,
      ),
    ).toMatchObject({ ok: true, transport: "process" });
    expect(
      admit(
        ask({ address: { kind: "actor", actorId: "a-1" }, mode: "assign", acceptanceCriteria: ["done"] }),
        RESIDENT,
        1000,
        LIMITS,
      ),
    ).toMatchObject({ ok: true, transport: "channel" });
  });

  test("a child presents as a worker one step deeper than its parent", () => {
    const decision = admit(ask(), RESIDENT, 1000, LIMITS);
    expect(decision).toMatchObject({ ok: true, childOrigin: { role: "worker", depth: 1, sessionId: "session-origin" } });
  });

  test("contract violations are reported, not thrown", () => {
    const refusal = admit(ask({ mode: "assign" }), RESIDENT, 1000, LIMITS);
    expect(refusal).toMatchObject({ ok: false, reason: expect.stringContaining("acceptance criterion") });
  });
});

describe("kernel", () => {
  test("a missing driver is delivery_failed, never a silent worker", async () => {
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1000,
      newDelegationId: () => "d-1",
      limits: LIMITS,
    });
    const result = await kernel.delegate(ask(), RESIDENT);
    expect(result).toMatchObject({
      settled: { status: "delivery_failed", reason: "no driver for inline transport" },
    });
  });

  test("a worker that stays silent settles as no_response at its deadline, not before", async () => {
    const kernel = createDelegationKernel({
      drivers: {
        inline: {
          run: (_admitted, _handle, signal) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => resolve({ status: "cancelled", reason: "aborted" }));
            }),
        },
      },
      now: () => 1000,
      newDelegationId: () => "d-1",
      limits: LIMITS,
    });
    const result = await kernel.delegate(ask({ deadline: 1030 }), RESIDENT);
    expect(result).toMatchObject({ settled: { status: "no_response", deadline: 1030, at: 1030 } });
  });

  test("a driver that throws settles as failed rather than escaping the kernel", async () => {
    const kernel = kernelWith({
      run: () => Promise.reject(new Error("child loop exploded")),
    });
    const result = await kernel.delegate(ask(), RESIDENT);
    expect(result).toMatchObject({ settled: { status: "failed", error: "child loop exploded" } });
  });

  test("the handle carries the address it was admitted for", async () => {
    const kernel = kernelWith({ run: async () => ({ status: "completed", output: "done" }) });
    const result = await kernel.delegate(ask(), RESIDENT);
    expect(result).toMatchObject({
      handle: { delegationId: "d-1", address: { kind: "core", scope: "inline" }, transport: "inline" },
      settled: { status: "completed", output: "done", delegationId: "d-1" },
    });
  });
});

describe("inline driver", () => {
  test("a child that answers after the deadline is not reported as a completion", async () => {
    const controller = new AbortController();
    const driver = createInlineDriver(async () => {
      controller.abort();
      return "an answer nobody is waiting for any more";
    });
    const outcome = await driver.run(
      { ok: true, request: ask() as never, transport: "inline", childOrigin: WORKER },
      { delegationId: "d-1", address: { kind: "core", scope: "inline" }, transport: "inline" },
      controller.signal,
    );
    expect(outcome).toMatchObject({ status: "cancelled", reason: "deadline reached" });
  });

  test("the child is handed the instruction and criteria, never the parent transcript", async () => {
    let seen: unknown;
    const driver = createInlineDriver(async (input) => {
      seen = input;
      return "ok";
    });
    await driver.run(
      {
        ok: true,
        request: ask({ mode: "assign", acceptanceCriteria: ["build is green"] }) as never,
        transport: "inline",
        childOrigin: WORKER,
      },
      { delegationId: "d-7", address: { kind: "core", scope: "inline" }, transport: "inline" },
      new AbortController().signal,
    );
    expect(seen).toMatchObject({
      delegationId: "d-7",
      instruction: "what is the state of the build",
      acceptanceCriteria: ["build is green"],
    });
  });

  test("descending carries who the child is, so nothing downstream decides it again", async () => {
    const origins: DelegationOrigin[] = [];
    const driver = createInlineDriver(async (input) => {
      origins.push(input.origin);
      return "ok";
    });
    for (const parentDepth of [0, 1]) {
      const decision = admit(ask(), { role: "worker", depth: parentDepth, sessionId: "session-origin" }, 1000, LIMITS);
      if (!decision.ok) throw new Error(`expected admission at depth ${parentDepth}`);
      await driver.run(
        decision,
        { delegationId: "d-1", address: { kind: "core", scope: "inline" }, transport: "inline" },
        new AbortController().signal,
      );
    }
    // Both halves come from admission: the depth so the cap cannot be reset by
    // recursing, and the role so nothing downstream gets to declare a child a
    // worker on its own authority.
    expect(origins).toEqual([
      { role: "worker", depth: 1, sessionId: "session-origin" },
      { role: "worker", depth: 2, sessionId: "session-origin" },
    ]);
  });
});

describe("delegate tool", () => {
  test("the advertised schema and the runtime gate accept the same calls", () => {
    const spec = delegateToolSpec();
    const advertised = spec.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(spec.name).toBe(DELEGATE_TOOL_NAME);
    // Every advertised field must survive the runtime parse, and every
    // required field must actually be required — otherwise the model is being
    // told about a call the executor will reject.
    const full = {
      instruction: "check the build",
      mode: "assign" as const,
      scope: "inline" as const,
      acceptanceCriteria: ["green"],
      timeoutMs: 5000,
    };
    const kernel = kernelWith({ run: async () => ({ status: "completed", output: "green" }) });
    const execute = delegateToolExecutor(kernel, RESIDENT);
    expect(Object.keys(advertised.properties).sort()).toEqual(
      [...Object.keys(full), "actorId"].sort(),
    );
    expect(advertised.required.sort()).toEqual(["instruction", "mode", "timeoutMs"]);
    expect(advertised.properties.mode?.enum).toEqual(["ask", "assign"]);
    expect(advertised.properties.scope?.enum).toEqual(["inline", "independent"]);
    return expect(execute(full)).resolves.toBe("green");
  });

  test("the bound origin decides, so the same call refuses for a worker", async () => {
    const independent = {
      instruction: "commission independent work",
      mode: "assign" as const,
      scope: "independent" as const,
      acceptanceCriteria: ["done"],
      timeoutMs: 5000,
    };
    const forResident = kernelWith(
      { run: async () => ({ status: "completed", output: "commissioned" }) },
      "process",
    );
    await expect(delegateToolExecutor(forResident, RESIDENT)(independent)).resolves.toBe("commissioned");

    const forWorker = kernelWith(
      { run: async () => ({ status: "completed", output: "must not happen" }) },
      "process",
    );
    await expect(delegateToolExecutor(forWorker, WORKER)(independent)).resolves.toContain(
      "ask the Resident for independent work",
    );
  });

  test("a model cannot smuggle its own origin in as an argument", async () => {
    const kernel = kernelWith({ run: async () => ({ status: "completed", output: "unreachable" }) });
    const answer = await delegateToolExecutor(kernel, WORKER)({
      instruction: "commission independent work",
      mode: "assign",
      scope: "independent",
      acceptanceCriteria: ["done"],
      timeoutMs: 5000,
      origin: { role: "resident", depth: 0, sessionId: "session-origin" },
    });
    expect(answer).toBe("delegate refused: Unrecognized key(s) in object: 'origin'");
  });

  test("an assign reaches the worker carrying the criteria that define its completion", async () => {
    let received: readonly string[] | undefined;
    const kernel = createDelegationKernel({
      drivers: {
        inline: createInlineDriver((input) => {
          received = input.acceptanceCriteria;
          return Promise.resolve("criteria met");
        }),
      },
      now: () => Date.now(),
      newDelegationId: () => "d-assign",
      limits: LIMITS,
    });

    const answer = await delegateToolExecutor(kernel, RESIDENT)({
      instruction: "ship it",
      mode: "assign",
      scope: "inline",
      acceptanceCriteria: ["build is green", "tests pass"],
      timeoutMs: 3000,
    });

    expect(answer).toBe("criteria met");
    expect(received).toEqual(["build is green", "tests pass"]);
  });

  test("the deadline stops the running child rather than only bookkeeping it", async () => {
    let childWasSignalled = false;
    const kernel = createDelegationKernel({
      drivers: {
        inline: createInlineDriver(
          (input) =>
            new Promise<string>((resolve) => {
              const timer = setTimeout(
                () => resolve("an answer nobody is waiting for"),
                5000,
              );
              input.signal.addEventListener("abort", () => {
                childWasSignalled = true;
                clearTimeout(timer);
                resolve("stopped");
              });
            }),
        ),
      },
      now: () => Date.now(),
      newDelegationId: () => "d-cancel",
      limits: LIMITS,
    });

    const settledAt = Date.now();
    const result = await kernel.delegate(
      {
        address: { kind: "core", scope: "inline" },
        mode: "ask",
        payload: { text: "a job longer than its deadline" },
        deadline: Date.now() + 80,
      },
      RESIDENT,
    );

    expect("handle" in result && result.settled.status).toBe("no_response");
    expect(Date.now() - settledAt).toBeLessThan(4000);
    // The child is told to stop. Without this the deadline would be bookkeeping:
    // the parent stops waiting while the work keeps burning.
    expect(childWasSignalled).toBe(true);
  });

  test("no_response is worded as an unknown outcome rather than a failure", async () => {
    const kernel = createDelegationKernel({
      drivers: { inline: { run: () => new Promise(() => undefined) } },
      now: () => Date.now(),
      newDelegationId: () => "d-1",
      limits: LIMITS,
    });
    const answer = await delegateToolExecutor(kernel, RESIDENT)({
      instruction: "wait for nothing",
      mode: "ask",
      scope: "inline",
      timeoutMs: 30,
    });
    expect(answer).toBe("no response before the deadline — the outcome is unknown, not a failure to act");
  });
});
