import { test } from "bun:test";
import { Effect } from "effect";
import { ForeignFailure } from "@openomni/agent";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { planeOf } from "./helpers/ledger";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { assistantMessage, commissionInput, requestToolStep } from "./helpers/assistant-message";
import { ownerStart } from "./helpers/owner-start";

// Probe-only: surface the cause chain that ForeignFailure's empty message hides.
ForeignFailure.prototype.toString = function (this: { operation: string; cause: string }) {
  return `ForeignFailure(${this.operation} :: ${this.cause})`;
};

const suite = residentSuite();

test("probe in-turn commission", async () => {
  let commissioned = false;
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  const done = Promise.withResolvers<void>();
  const app = await suite.boot({
    config: suite.config("probe-commission-"),
    sessionRuntime: { clock: () => 100 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.gen(function* () {
          const runPlane = planeRef.current;
          if (runPlane === undefined) throw new Error("plane not resolved");
          const role = runPlane.openKernel(input.trace.sessionId).row(input.trace.sessionId).role;
          console.log("PROBE run", input.trace.sessionId, role);
          if (role === "worker") {
            sink.onMessage(assistantMessage(input, { text: "CHILD_RESULT" }));
            return { type: "stop" as const };
          }
          if (!commissioned) {
            const output = requestToolStep(input, sink, {
              id: "commission",
              tool: "send_message",
              input: commissionInput({ message: "work", deadline_ms: 900, reply_to: "ORIGINAL" }),
            });
            if (output === undefined) return { type: "stop" as const };
            console.log("PROBE commission", JSON.stringify(output).slice(0, 2000));
            commissioned = true;
            done.resolve();
          }
          sink.onMessage(assistantMessage(input, { text: "PARENT" }));
          return { type: "stop" as const };
        }),
    },
  });
  planeRef.current = await planeOf(app.runtime);
  await ownerStart(app, "initial");
  await done.promise;
  const { sessionTree } = await import("../../../packages/ledger/test/helpers/session-tree");
  for (const row of planeRef.current.listSessions()) {
    for (const action of sessionTree(row.id, planeRef.current.sessionStore(row.id).actions)) {
      const text = JSON.stringify(action.effect);
      if (text.includes("failures\":[{")) console.log("PROBE evidence", row.id, action.kind, text.slice(0, 1500));
    }
  }
});
