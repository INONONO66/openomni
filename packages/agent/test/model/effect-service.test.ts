import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { Llm, Provider, run } from "../../src/model";
import { AgentFailure } from "../../src/model/errors";
import { usePrivateCatalog } from "./helpers/catalog";
import { fixedNow } from "./helpers/fixtures";
import { runEffect } from "./helpers/native";

usePrivateCatalog();

test("the LLM service resolves the trusted catalog and preserves resolution failures", async () => {
  const service = Context.get(Context.make(Llm, { run: (input, sink, dependencies) => run({ ...input, authFilePath: "/nonexistent/openomni-test/auth.json" }, sink, dependencies), resolveModel: (input) => Provider.resolveModel({ ...input, authFilePath: "/nonexistent/openomni-test/auth.json" }) }), Llm);
  expect(await runEffect(service.resolveModel({ provider: "anthropic", id: "fixture-claude", now: fixedNow }))).toMatchObject({
    id: "fixture-claude", providerID: "anthropic", name: "Fixture Claude",
  });
  expect(await runEffect(Effect.flip(service.resolveModel({ provider: "absent", id: "model", now: fixedNow })))).toMatchObject({
    _tag: "ModelResolutionError", provider: "absent", model: "model", reason: "provider_not_found",
  });
  const failure = new AgentFailure({ operation: "transport", cause: "connection_lost" });
  expect(await runEffect(Effect.flip(failure))).toBe(failure);
  expect(failure.message).toBe("transport: connection_lost");
});
