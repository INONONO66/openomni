import { describe, expect, it } from "bun:test";
import { toolInputSchema, toolSpec } from "@openomni/agent";
import type { PlainValue } from "@openomni/protocol";
import { collectToolSpecs, createTools, TOOL_DEFINITIONS, type CatalogPorts } from "./catalog";

/** KERNEL §3.4/§3.5: the sealed model door, in catalog order, then the one cell-only tool. */
const MODEL_DOOR = [
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
  "bash",
  "eval",
  "monitor",
  "send_message",
  "provision",
];
const CELL_ONLY = ["completion"];
const FILE_TOOLS = ["read", "write", "edit", "ls", "find", "grep", "bash"];
/** Every multi-operation tool takes `operation: { op, ... }`; these are the exact op sets. */
const OPS: Record<string, readonly string[]> = {
  eval: ["run", "peek", "stop"],
  monitor: ["create", "rearm", "cancel"],
  provision: [
    "contact_add",
    "contact_remove",
    "contact_promote",
    "contact_merge",
    "channel_add",
    "channel_enable",
    "channel_disable",
    "secret_rotate",
    "status",
  ],
};
/** Vocabulary retired by #949; none of it may reappear on either door. */
const RETIRED = [
  "list",
  "search",
  "run_code",
  "llm",
  "llm_batched",
  "sendMessage",
  "approval",
  "delegate",
  "await_delegation",
  "cancel_delegation",
  "work_items",
  "converse",
  "memory",
  "artifacts",
  "fs_read",
  "fs_list",
  "fs_stat",
  "machines",
];

function record(value: PlainValue | undefined): Record<string, PlainValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** The `op` literals of `operation`'s discriminated union, in declaration order. */
function operationOps(name: string): readonly string[] {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (definition === undefined) throw new Error(`missing tool ${name}`);
  const operation = record(record(toolInputSchema(definition).properties).operation);
  const variants = operation.oneOf ?? operation.anyOf;
  return (Array.isArray(variants) ? variants : []).map((variant) => {
    const op = record(record(record(variant).properties).op);
    return typeof op.const === "string" ? op.const : "";
  });
}

describe("tool catalog", () => {
  it("reuses immutable role catalogs and binds only their own ports", async () => {
    const origin = { role: "resident", sessionId: "catalog-test" } as const;
    const ports: CatalogPorts = { llm: async ({ prompt }) => `first:${prompt}` };
    const first = createTools(ports, origin);
    expect(createTools(ports, { ...origin, sessionId: "other" })).toBe(first);
    const worker = createTools(ports, { ...origin, role: "worker" });
    expect(worker.some((tool) => tool.name === "provision")).toBe(false);
    expect(worker.find((tool) => tool.name === "read")).toBe(first.find((tool) => tool.name === "read"));
    const replacement = createTools({ llm: async ({ prompt }) => `second:${prompt}` }, origin);
    expect(replacement).not.toBe(first);
    expect(replacement.find((tool) => tool.name === "completion")).not.toBe(
      first.find((tool) => tool.name === "completion"),
    );
  });
  it("is sealed at eleven model-door tools plus the cell-only completion", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...MODEL_DOOR, ...CELL_ONLY]);
    expect(collectToolSpecs().map((tool) => tool.name)).toEqual([...MODEL_DOOR, ...CELL_ONLY]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.visibility.model.length > 0).toBe(MODEL_DOOR.includes(tool.name));
      expect(tool.visibility.cell.length > 0).toBe(true);
      expect(RETIRED).not.toContain(tool.name);
    }
  });
  it("uses snake_case names and one `op` discriminator under `operation`", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/);
      const properties = Object.keys(record(toolInputSchema(tool).properties));
      expect(properties.some((key) => /^(op|action|command_kind|operation_kind)$/.test(key))).toBe(
        false,
      );
      expect(properties.includes("operation")).toBe(tool.name in OPS);
    }
    for (const [name, ops] of Object.entries(OPS)) expect(operationOps(name)).toEqual(ops);
  });
  it("projects every input as an object root", () => {
    for (const definition of TOOL_DEFINITIONS)
      expect(toolInputSchema(definition).type).toBe("object");
  });
  it("derives safe solely from category and shares both doors for path tools", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(toolSpec(tool).safe).toBe(tool.category === "query");
      expect(toolSpec(tool)).not.toHaveProperty("placement");
      if (FILE_TOOLS.includes(tool.name)) {
        expect(tool.visibility).toEqual({
          model: ["resident", "worker"],
          cell: ["resident", "worker"],
        });
        expect(tool.sequential).toBe(
          ["write", "edit", "bash"].includes(tool.name) ? true : undefined,
        );
      }
    }
  });
  it("keeps completion cell-only with exactly prompt, model, system and schema", () => {
    const completion = TOOL_DEFINITIONS.find((tool) => tool.name === "completion");
    if (completion === undefined) throw new Error("missing completion");
    expect(completion.visibility).toEqual({ model: [], cell: ["resident", "worker"] });
    const schema = toolInputSchema(completion);
    expect(Object.keys(record(schema.properties)).sort()).toEqual([
      "model",
      "prompt",
      "schema",
      "system",
    ]);
    expect(schema.required).toEqual(["prompt"]);
  });
});
