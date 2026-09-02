import { expect, test } from "bun:test";
import { Delegation } from "@openomni/protocol";

test("CommandV1 rejects duplicate criterion expectations", () => {
  // Given: a declaration with two expectations bound to the same criterion.
  const duplicate = {
    kind: "command.v1",
    executable: { id: "bun" },
    argv: ["test"],
    timeoutMs: 60_000,
    expectations: [
      { criterionIndex: 0, exitCode: 0 },
      { criterionIndex: 0, exitCode: 1 },
    ],
  };

  // When: the declaration itself is parsed at its protocol boundary.
  const parsed = Delegation.CommandV1.safeParse(duplicate);

  // Then: duplicate criterion bindings are rejected before request context exists.
  expect(parsed.success).toBe(false);
});
