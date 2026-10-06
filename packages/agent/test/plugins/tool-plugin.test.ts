import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createDispatcher } from "../../src/plugins/tool";
import { runAgentSync } from "../helpers/executor";
import { catalogLayer } from "../helpers/service-layers";
import { recordingExecutor } from "../helpers/effect-g2";
import { valueTool } from "../helpers/query-tool";
import { isolated } from "../helpers/isolated";

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = { id: "call-1", tool: "echo", input: { value: "input" } };

describe("plugins/tool dispatcher export (#1316)", () => {
  it("builds a dispatcher through the plugin export and records the dispatched tool action", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const recording = recordingExecutor();
          const dispatch = runAgentSync(
            createDispatcher({ executor: recording.executor }).pipe(
              Effect.provide(catalogLayer([
                valueTool({ name: "echo", description: "Echo a value", execute: async () => "ok" }),
              ])),
            ),
          );
          const result = yield* dispatch.execute(call, context);
          expect(result).toMatchObject({ id: call.id, toolName: "echo", content: "ok" });
          expect(result.isError).toBeUndefined();
          expect(recording.committed.some((action) => action.kind === "tool")).toBe(true);
        }),
      ),
    ));
});
