import { describe, expect, test } from "bun:test";
import { NamedError } from "@openomni/protocol";
import { z } from "zod";
import { frozenWriteRefusal } from "../../src/storage/frozen";

/**
 * S2 duplicate-logic audit — unit coverage for the shared frozen-store
 * write-refusal helper consumed by PendingAskStore (#510 D2a),
 * PendingInteractionStore (#548), and WorkerRunStateStore (#510 D2b). The
 * per-store pins (typed class, data.code, data.method, message text) stay
 * with the stores' own tests; this suite pins the helper's contract:
 * constructor passthrough, code passthrough, and method interpolation.
 */

const TestFrozenError = NamedError.create(
  "TestFrozenError",
  z.object({
    message: z.string(),
    code: z.literal("test_frozen"),
    method: z.enum(["create", "update"]),
  }),
);
type TestFrozenError = InstanceType<typeof TestFrozenError>;

const frozenWrite = frozenWriteRefusal(
  TestFrozenError,
  "test_frozen",
  (method) => `TestStore is frozen: ${method} is retired`,
);

function catchThrown(fn: () => never): TestFrozenError {
  try {
    fn();
  } catch (error) {
    if (TestFrozenError.isInstance(error)) return error;
    throw new Error(`expected the typed TestFrozenError, got: ${String(error)}`);
  }
  throw new Error("expected frozenWrite to throw");
}

describe("frozenWriteRefusal", () => {
  test("throws the supplied error constructor with the pinned code and refused method", () => {
    const thrown = catchThrown(() => frozenWrite("create"));
    expect(thrown.name).toBe("TestFrozenError");
    expect(thrown.data.code).toBe("test_frozen");
    expect(thrown.data.method).toBe("create");
  });

  test("interpolates the refused method into the message template", () => {
    const thrown = catchThrown(() => frozenWrite("update"));
    expect(thrown.data.message).toBe("TestStore is frozen: update is retired");
    expect(thrown.message).toBe("TestStore is frozen: update is retired");
  });

  test("each refusal builds a fresh error carrying that call's method", () => {
    const first = catchThrown(() => frozenWrite("create"));
    const second = catchThrown(() => frozenWrite("update"));
    expect(first).not.toBe(second);
    expect(first.data.method).toBe("create");
    expect(second.data.method).toBe("update");
  });
});
