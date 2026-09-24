import { closeSync, openSync, writeSync } from "node:fs";
import { bundle, ObservationSink, type BundleDefinition } from "@openomni/agent";
import { Tool } from "@openomni/protocol";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { contentBlocks, messageEnd, messageStart, sseResponse } from "./anthropic-sse";

export const ProviderRequest = z.object({
  tools: z.array(z.object({ name: z.string() })).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]) })),
});

/** Real file and subscriptions, acquired only inside a selected generation. */
export function auditBundle(path: string): {
  readonly definition: BundleDefinition & { readonly provides: readonly []; readonly requires: readonly [typeof ObservationSink] };
  readonly acquired: number[];
  readonly closed: number[];
  readonly whenClosed: (acquisition: number) => Promise<void>;
} {
  const acquired: number[] = [];
  const closed: number[] = [];
  const witnesses = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const live = Layer.scopedDiscard(Effect.gen(function* () {
    const events = yield* ObservationSink;
    yield* Effect.acquireRelease(Effect.sync(() => {
      const id = acquired.length + 1;
      acquired.push(id);
      witnesses.set(id, Promise.withResolvers<void>());
      const fd = openSync(path, "a");
      const subscriptions = [Tool.Events.Started, Tool.Events.Completed].map((event) =>
        events.subscribe(event, (data) => writeSync(fd, `${JSON.stringify({ acquisition: id, event: event.name, data })}\n`)),
      );
      return { id, fd, subscriptions };
    }), ({ id, fd, subscriptions }) => Effect.sync(() => {
      for (const unsubscribe of subscriptions) unsubscribe();
      closeSync(fd);
      closed.push(id);
      witnesses.get(id)?.resolve();
    }));
  }));
  return { definition: bundle({ name: "audit-log", provides: [], requires: [ObservationSink], layer: live }), acquired, closed,
    whenClosed: (id) => {
      const witness = witnesses.get(id);
      if (witness === undefined) throw new Error(`acquisition ${id} has not started`);
      return witness.promise;
    },
  };
}

export function providerResponse(call?: { readonly name: string; readonly input: object }): Response {
  return sseResponse([
    messageStart(crypto.randomUUID(), "fixture", 10),
    ...contentBlocks(call === undefined
      ? [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "done" } }]
      : [{ start: { type: "tool_use", id: crypto.randomUUID(), name: call.name, input: {} }, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }]),
    ...messageEnd(call === undefined ? "end_turn" : "tool_use", 2),
  ]);
}
