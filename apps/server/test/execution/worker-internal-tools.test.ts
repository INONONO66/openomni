import { describe, expect, it } from "bun:test";

import { WorkerInternalTools } from "../../src/execution/worker-internal-tools";

describe("worker internal tools", () => {
  it("does not expose polling tools after migration to inbound message injection", () => {
    const tools = WorkerInternalTools.create();

    expect(tools.map((tool) => tool.spec.name)).toEqual([]);
    expect(tools.some((tool) => tool.spec.name === "check_inbox")).toBe(false);
    expect(tools.some((tool) => tool.spec.name === "ask_main")).toBe(false);
  });
});
