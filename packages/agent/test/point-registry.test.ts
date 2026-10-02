import { describe, expect, it } from "bun:test";
import { compileGateRows } from "../src/kernel/gate/compose";
import {
  composePointTable,
  GateComposeError,
  KERNEL_CAPABILITY_POINTS,
} from "../src/kernel/points";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

function rejectionCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (GateComposeError.isInstance(error)) return error.data.code;
    throw error;
  }
  throw new Error("expected a compose rejection");
}

describe("point registration table (#1251)", () => {
  it("merges eight core points with the composed capabilities' points", () => {
    const table = fullPointTable();
    expect(table.size).toBe(14);
    expect(table.get("tool.pre")?.owner).toBe("tool");
    expect(table.get("turn.post")?.end).toBe(true);
  });

  it("rejects a duplicate capability point registration with `duplicate`", () => {
    expect(
      rejectionCode(() =>
        composePointTable({
          capabilities: [
            { bundle: "tool", points: ["tool.pre"] },
            { bundle: "shadow-tool", points: ["tool.pre"] },
          ],
        }),
      ),
    ).toBe("duplicate");
  });

  it("rejects a registration without a point record with `unknown_point`", () => {
    expect(
      rejectionCode(() =>
        composePointTable({
          capabilities: [{ bundle: "tool", points: ["ingress.pre"] }],
        }),
      ),
    ).toBe("unknown_point");
  });
});

describe("gate-row compose rejections (#1251)", () => {
  const table = fullPointTable();
  const compile = (rows: readonly ReturnType<typeof gateRow>[], handlers: readonly string[] = []) =>
    compileGateRows({ table, rows, handlers, generation: 1 });

  it("rejects a row on an off or absent capability's point with `unknown_point`, never a silent no-op", () => {
    const withoutAction = composePointTable({
      capabilities: KERNEL_CAPABILITY_POINTS.filter((capability) => capability.bundle !== "action"),
    });
    expect(withoutAction.has("action.pre")).toBe(false);
    expect(
      rejectionCode(() =>
        compileGateRows({
          table: withoutAction,
          rows: [gateRow("action.pre")],
          handlers: [],
          generation: 1,
        }),
      ),
    ).toBe("unknown_point");
  });

  it("rejects an unregistered `how.ref` with `unknown_handler`", () => {
    expect(
      rejectionCode(() => compile([gateRow("tool.pre", { how: { ref: "guard/absent" } })])),
    ).toBe("unknown_handler");
    expect(() =>
      compile([gateRow("tool.pre", { how: { ref: "guard/present" } })], ["guard/present"]),
    ).not.toThrow();
  });

  it("rejects a duplicate row id with `duplicate`", () => {
    const row = gateRow("tool.pre");
    expect(rejectionCode(() => compile([row, { ...row, order: row.order + 1 }]))).toBe("duplicate");
  });

  it("rejects an action outside the point record with `bad_action`", () => {
    expect(rejectionCode(() => compile([gateRow("compaction.post")]))).toBe("bad_action");
    expect(rejectionCode(() => compile([gateRow("alarm.fired")]))).toBe("bad_action");
  });

  it("rejects condition and rewrite fields outside the point record with `bad_field`", () => {
    expect(rejectionCode(() => compile([gateRow("tool.pre", { when: { model: "x" } })]))).toBe(
      "bad_field",
    );
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("tool.pre", { do: "rewrite", how: { ref: "guard/rewrite", fields: ["output"] } })],
          ["guard/rewrite"],
        ),
      ),
    ).toBe("bad_field");
  });

  it("rejects a post-end emit with `post_end_emit`", () => {
    expect(
      rejectionCode(() => compile([gateRow("turn.post", { do: "emit", how: { emit: "message" } })])),
    ).toBe("post_end_emit");
  });

  it("rejects prompt and signal emissions: the emit set is message | alarm.arm | compaction only", () => {
    for (const emit of ["prompt", "signal"]) {
      expect(
        rejectionCode(() => compile([gateRow("tool.post", { do: "emit", how: { emit } })])),
      ).toBe("bad_action");
    }
    for (const emit of ["message", "alarm.arm", "compaction"]) {
      expect(() =>
        compile([gateRow("tool.post", { do: "emit", how: { emit, intent: { body: "x" } } })]),
      ).not.toThrow();
    }
  });
});
