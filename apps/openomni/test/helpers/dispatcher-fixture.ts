import { createDispatcher, ToolCatalog } from "@openomni/agent";
import type { AnyToolDefinition } from "@openomni/protocol";
import { Effect } from "effect";
import { runSyncEffect } from "./effect";

export function dispatcherFixture(definitions: readonly AnyToolDefinition[], options?: Parameters<typeof createDispatcher>[0]) {
  return runSyncEffect(createDispatcher(options).pipe(Effect.provideService(ToolCatalog, { definitions })));
}
