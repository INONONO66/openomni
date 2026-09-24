import { expect, test } from "bun:test";
import { SessionGeneration } from "../src/index";

test("existing Snapshot retains requested durable bundle identity", () => {
  const requested = {
    generation: 1,
    revertTo: 0,
    tools: [],
    toolsHash: "tools",
    systemPreset: "",
    systemBlocks: [],
    systemValue: "",
    systemHash: "system",
    policyGeneration: 1,
    bundles: ["audit", "demo"],
  };

  const decoded = SessionGeneration.Snapshot.safeParse(requested);

  expect(decoded.success).toBe(true);
  expect(decoded.data).toMatchObject({ bundles: ["audit", "demo"] });
});
