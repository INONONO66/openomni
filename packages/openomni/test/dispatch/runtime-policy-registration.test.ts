import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyDecision, type Dispatch as DispatchProtocol } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { DispatchPolicyRegistrationError } from "../../src/index";
import { DispatchRuntime } from "../../src/dispatch/runtime";

function submitUntrustedPolicy(policy: unknown): {
  readonly submission: Promise<DispatchProtocol.Result>;
  readonly handlerWasCalled: () => boolean;
} {
  let handlerCalled = false;
  const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
  runtime.register("resident.ask", () => {
    handlerCalled = true;
    return { output: "must not run" };
  });
  const submission: Promise<DispatchProtocol.Result> = Reflect.apply(runtime.submit, runtime, [
    { action: "resident.ask", target: { kind: "resident" }, payload: "hello" },
    {
      sessionId: "session-untrusted-policy",
      runId: "run-untrusted-policy",
      policies: [policy],
    },
  ]);
  return { submission, handlerWasCalled: () => handlerCalled };
}

async function rejectionOf(submission: Promise<DispatchProtocol.Result>): Promise<Error> {
  try {
    await submission;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error("Expected dispatch policy rejection");
}

describe("DispatchRuntime policy registration boundary", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("rejects legacy policies before policy and handler execution", async () => {
    let policyCalled = false;
    const policy = {
      name: "stale-deny-policy",
      timing: "dispatch.authorize",
      priority: 0,
      fn: () => {
        policyCalled = true;
        return PolicyDecision.deny({ policyId: "stale-deny-policy" });
      },
    };
    const { submission, handlerWasCalled } = submitUntrustedPolicy(policy);

    const error = await rejectionOf(submission);

    expect(error).toBeInstanceOf(DispatchPolicyRegistrationError);
    expect(error).toMatchObject({
      name: "DispatchPolicyRegistrationError",
      code: "legacy_policy_not_supported",
      registrationName: "stale-deny-policy",
    });
    expect(policyCalled).toBe(false);
    expect(handlerWasCalled()).toBe(false);
  });

  test("wraps a throwing registration name getter at the typed boundary", async () => {
    const cause = new Error("name trap");
    const { submission, handlerWasCalled } = submitUntrustedPolicy({
      get name() {
        throw cause;
      },
      timing: "dispatch.authorize",
    });

    const error = await rejectionOf(submission);

    expect(error).toBeInstanceOf(DispatchPolicyRegistrationError);
    expect(error).toMatchObject({
      code: "invalid_policy_registration",
      registrationName: "<unknown>",
    });
    expect(error.cause).toBe(cause);
    expect(handlerWasCalled()).toBe(false);
  });

  test("wraps a throwing registration kind proxy without rereading its name", async () => {
    const cause = new Error("kind trap");
    let nameReads = 0;
    const policy = new Proxy(
      {
        get name() {
          nameReads += 1;
          return "kind-trap-policy";
        },
      },
      {
        get(target, property, receiver) {
          if (property === "kind") throw cause;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const { submission, handlerWasCalled } = submitUntrustedPolicy(policy);

    const error = await rejectionOf(submission);

    expect(error).toBeInstanceOf(DispatchPolicyRegistrationError);
    expect(error).toMatchObject({
      code: "invalid_policy_registration",
      registrationName: "kind-trap-policy",
    });
    expect(error.cause).toBe(cause);
    expect(nameReads).toBe(1);
    expect(handlerWasCalled()).toBe(false);
  });

  test("wraps a throwing registration pointIds getter at the typed boundary", async () => {
    const cause = new Error("pointIds trap");
    const { submission, handlerWasCalled } = submitUntrustedPolicy({
      name: "pointIds-trap-policy",
      kind: "point",
      get pointIds() {
        throw cause;
      },
    });

    const error = await rejectionOf(submission);

    expect(error).toBeInstanceOf(DispatchPolicyRegistrationError);
    expect(error).toMatchObject({
      code: "invalid_policy_registration",
      registrationName: "pointIds-trap-policy",
    });
    expect(error.cause).toBe(cause);
    expect(handlerWasCalled()).toBe(false);
  });

  test("preserves a non-Error hostile inspection cause by identity", async () => {
    const cause = Object.freeze({ type: "pointIds trap" });
    const { submission, handlerWasCalled } = submitUntrustedPolicy({
      name: "non-error-trap-policy",
      kind: "point",
      get pointIds() {
        throw cause;
      },
    });

    const error = await rejectionOf(submission);

    expect(error).toBeInstanceOf(DispatchPolicyRegistrationError);
    expect(error.cause).toBe(cause);
    expect(handlerWasCalled()).toBe(false);
  });

  test("rethrows an already-classified inspection error unchanged", async () => {
    const classified = new DispatchPolicyRegistrationError(
      "invalid_policy_registration",
      "classified-policy",
    );
    const { submission, handlerWasCalled } = submitUntrustedPolicy({
      name: "classified-policy",
      kind: "point",
      pointIds: ["dispatch.action.pre"],
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "classified-policy" }),
      get effectCapabilities() {
        throw classified;
      },
    });

    const error = await rejectionOf(submission);

    expect(error).toBe(classified);
    expect(handlerWasCalled()).toBe(false);
  });

  test("snapshots changing policy point accessors before dispatch policy registration", async () => {
    type CanonicalField =
      | "kind"
      | "name"
      | "pointIds"
      | "effectCapabilities"
      | "priority"
      | "scope"
      | "failPolicy"
      | "fn"
      | "propagate";
    const reads: Record<CanonicalField, number> = {
      kind: 0,
      name: 0,
      pointIds: 0,
      effectCapabilities: 0,
      priority: 0,
      scope: 0,
      failPolicy: 0,
      fn: 0,
      propagate: 0,
    };
    function observed<Value>(field: CanonicalField, value: Value): Value {
      reads[field] += 1;
      return value;
    }
    let policyCalls = 0;
    const { submission, handlerWasCalled } = submitUntrustedPolicy({
      get name() {
        return observed("name", "changing-point-policy");
      },
      get kind() {
        return observed("kind", "point");
      },
      get pointIds() {
        reads.pointIds += 1;
        return reads.pointIds === 1 ? ["dispatch.action.pre"] : ["run.lifecycle.post"];
      },
      get effectCapabilities() {
        return observed(
          "effectCapabilities",
          reads.pointIds === 1 ? { "dispatch.action.pre": [] } : { "run.lifecycle.post": [] },
        );
      },
      get priority() {
        return observed("priority", 0);
      },
      get scope() {
        return observed("scope", undefined);
      },
      get failPolicy() {
        return observed("failPolicy", undefined);
      },
      get fn() {
        return observed("fn", () => {
          policyCalls += 1;
          return PolicyDecision.deny({ policyId: "changing-point-policy" });
        });
      },
      get propagate() {
        return observed("propagate", undefined);
      },
    });

    const result = await submission;

    expect(result.status).toBe("denied");
    expect(reads).toEqual({
      kind: 1,
      name: 1,
      pointIds: 1,
      effectCapabilities: 1,
      priority: 1,
      scope: 1,
      failPolicy: 1,
      fn: 1,
      propagate: 1,
    });
    expect(policyCalls).toBe(1);
    expect(handlerWasCalled()).toBe(false);
  });
});
