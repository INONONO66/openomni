import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { Llm, Provider, run } from "../src/index";
import { ForeignFailure } from "../src/errors";
import { usePrivateCatalog } from "./helpers/catalog";
import { runEffect } from "./helpers/native";

usePrivateCatalog();

test("the LLM service resolves the trusted catalog and preserves resolution failures", async () => {
  const service = Context.get(Context.make(Llm, { run, resolveModel: Provider.resolveModel }), Llm);
  expect(await runEffect(service.resolveModel({ provider: "anthropic", id: "fixture-claude" }))).toMatchObject({
    id: "fixture-claude", providerID: "anthropic", name: "Fixture Claude",
  });
  expect(await runEffect(Effect.flip(service.resolveModel({ provider: "absent", id: "model" })))).toMatchObject({
    _tag: "ModelResolutionError", provider: "absent", model: "model", reason: "provider_not_found",
  });
  const failure = new ForeignFailure({ operation: "transport", cause: "connection_lost" });
  expect(await runEffect(Effect.flip(failure))).toBe(failure);
  expect(failure.message).toBe("connection_lost");
});
