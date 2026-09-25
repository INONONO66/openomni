import { expect, test } from "bun:test";
import { GenerationLayers, ToolCatalog, session, sessionTool } from "@openomni/agent";
import type { AnyToolDefinition } from "@openomni/protocol";
import { Effect, type Layer } from "effect";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../src/gateway";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { createResident } from "../src/resident";
import type { CatalogSelection, GenerationDefinitions } from "../src/composition/generation-layers";
import { testToolPorts } from "./helpers/tool-ports";
import { allowConfigure } from "./helpers/generation-services";

test("two turns retain one catalog Layer; configure acquires a fresh generation catalog", async () => {
  const layers: Layer.Layer<ToolCatalog>[] = [];
  const turns: (readonly AnyToolDefinition[])[] = [];
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  const resident = createResident({
    model: { provider: "test", id: "test" }, apiKey: "test", tools: testToolPorts,
    sessionRuntime: { authorizeConfigure: allowConfigure },
  });
  const schema = resident.definitions.resident;
  const definitions: GenerationDefinitions = {
    ...resident.definitions,
    catalogLayer: (select: CatalogSelection) => {
      const recipe = resident.definitions.catalogLayer;
      if (recipe === undefined) throw new Error("resident catalog Layer recipe missing");
      const layer = recipe(select);
      layers.push(layer);
      return layer;
    },
  };
  try {
    const handle = await acquireAppResource(runtime, Effect.gen(function* () {
      seedKernelPolicyRows();
      yield* (yield* GenerationLayers).initialize(definitions);
      return yield* session({
        id: "catalog-once", role: "resident", tools: schema.map(sessionTool),
        runner: () => Effect.gen(function* () {
          turns.push((yield* ToolCatalog).definitions);
          return { kind: "result" as const, text: "done" };
        }),
      }, { authorizeConfigure: allowConfigure });
    }));
    await runAppEffect(runtime, handle.prompt("first"));
    await runAppEffect(runtime, handle.prompt("second"));
    expect(layers).toHaveLength(1);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe(turns[0]);
    expect(turns[0]?.map((tool: AnyToolDefinition) => tool.name)).toEqual(schema.map((tool: AnyToolDefinition) => tool.name));
    await runAppEffect(runtime, handle.system.blocks.set([{ id: "changed", source: "test", content: "generation-two" }]));
    await runAppEffect(runtime, handle.prompt("third"));
    expect(layers).toHaveLength(2);
    expect(layers[1]).not.toBe(layers[0]);
    expect(turns[2]).not.toBe(turns[0]);
    expect(turns[2]?.[0]).not.toBe(turns[0]?.[0]);
  } finally {
    await runtime.dispose();
  }
});
