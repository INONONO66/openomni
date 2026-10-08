/**
 * #1305 end-to-end projection: a tool result far over the budget commits as a
 * bounded row referencing stored bytes; the full output reads back whole
 * through the kernel and `Inspect.toolOutput`; the budget folds from
 * `session.configure{settings.toolOutputBudgetBytes}` with the core default
 * when absent.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { canonicalDigest, canonicalJson, type LedgerAction, type PlainValue } from "@openomni/protocol";
import { useMemoryStores, testNow } from "./store/helpers/storage";
import { materializeSession, adoptWriter } from "./store/helpers/session";
import { testExecutor } from "./helpers/executor";
import { allowAllPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";
import { toolOutput as inspectToolOutput } from "../src/inspect";
import { configureAction } from "../src/core/store/fence";
import { consumptionSettings } from "../src/core/commit";
import { DEFAULT_TOOL_OUTPUT_BUDGET_BYTES } from "../src/core/tool-output";
import type { ExecutionLedger } from "../src/core/gate/decide";

const SESSION = "projection-session";

const stores = useMemoryStores();

let entropySeq = 0;

function kernelLedger(authority: { sessionId: string; owner: string; fence: number }): ExecutionLedger {
  return {
    commit: (action: LedgerAction.Append) =>
      Effect.suspend(() => {
        const row = stores.kernel.row(SESSION);
        return stores.kernel
          .commit({
            sessionId: SESSION,
            owner: authority.owner,
            fence: authority.fence,
            now: testNow(),
            expectedRevision: row.revision,
            actions: [action],
            state: row.state,
          })
          .pipe(
            Effect.map((committed) => {
              const receipt = committed.receipts[0];
              if (receipt === undefined) throw new Error("missing receipt");
              return receipt;
            }),
          );
      }),
    resultFor: (id) => stores.kernel.resultFor(SESSION, id),
    toolOutputBudgetBytes: () =>
      consumptionSettings(stores.kernel, SESSION).toolOutputBudgetBytes ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
    putToolOutput: (write) => stores.kernel.putToolOutput(write),
    toolOutput: (outputId) => stores.kernel.toolOutput(outputId),
  };
}

function toolExecutor(authority: { sessionId: string; owner: string; fence: number }) {
  return testExecutor({
    policy: allowAllPolicy,
    ledger: kernelLedger(authority),
    observations: { publish: () => undefined },
    identity: { sessionId: SESSION, role: "resident", parentActionId: null },
    clock: testNow,
    entropy: () => `projection-${++entropySeq}`,
    random: () => 0,
  });
}

function plainObject(value: PlainValue | undefined): Record<string, PlainValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object value");
  return value;
}

function resultRows(): LedgerAction.Node[] {
  const rows: LedgerAction.Node[] = [];
  let afterRevision = 0;
  for (;;) {
    const page = stores.kernel.historyPage(SESSION, { afterRevision, limit: 256 });
    for (const action of page.actions) {
      if (action.kind !== "tool") continue;
      if (plainObject(action.effect.value).phase === "result") rows.push(action);
    }
    if (page.nextRevision === null) return rows;
    afterRevision = page.nextRevision;
  }
}

function runTool(authority: { sessionId: string; owner: string; fence: number }, value: PlainValue) {
  const executor = toolExecutor(authority);
  return executor.run(
    { kind: "tool", op: "emit", intent: {}, effect: { category: "query" } },
    () => Effect.succeed(value),
  );
}

describe("tool output projection through the durable gate (#1305)", () => {
  it("a 1 MiB result commits as a bounded row whose ref reads back whole", () =>
    isolated(
      Effect.gen(function* () {
        materializeSession(stores.kernel, SESSION);
        const authority = adoptWriter(stores.kernel, SESSION);
        const bigText = "m".repeat(1_048_576);
        const value: PlainValue = { status: "ok", output: bigText };
        const outcome = yield* runTool(authority, value);
        expect(outcome.terminal).toBe("executed");
        if (outcome.terminal !== "executed") throw new Error("not executed");
        // The in-memory outcome handed back to the body's caller is full-size.
        expect(plainObject(outcome.value).output).toBe(bigText);

        const row = resultRows().at(-1);
        if (row === undefined) throw new Error("missing result row");
        const effect = plainObject(row.effect.value);
        // The committed row is bounded: well under the budget, never 1 MiB.
        const beforeBytes = Buffer.byteLength(canonicalJson(value), "utf8");
        const afterBytes = Buffer.byteLength(canonicalJson(row.effect.value), "utf8");
        // #1305 evidence: the measured row bytes before/after projection.
        console.log(`row bytes before projection: ${beforeBytes}; after: ${afterBytes}`);
        expect(afterBytes).toBeLessThan(DEFAULT_TOOL_OUTPUT_BUDGET_BYTES);
        // Replay identity: resultHash stays the digest of the FULL value.
        expect(effect.resultHash).toBe(canonicalDigest(value));
        const ref = plainObject(plainObject(effect.result).outputRef);
        expect(ref.mediaType).toBe("application/json");
        expect(ref.bytes).toBe(Buffer.byteLength(canonicalJson(value), "utf8"));
        const outputId = ref.outputId;
        if (typeof outputId !== "string") throw new Error("missing outputId");
        expect(outputId).toBe(canonicalDigest(value));

        // Kernel read-back: the stored bytes are the full canonical JSON.
        const stored = stores.kernel.toolOutput(outputId);
        if (stored === undefined) throw new Error("output not stored");
        expect(new TextDecoder().decode(stored.bytes)).toBe(canonicalJson(value));

        // Inspect read model resolves the same identifier, typed.
        const inspected = inspectToolOutput(stores.kernel, outputId);
        if (inspected.kind !== "output") throw new Error("expected output");
        if (typeof ref.bytes !== "number") throw new Error("missing ref bytes");
        expect(inspected.bytes).toBe(ref.bytes);
        expect(inspected.mediaType).toBe("application/json");
        expect(inspected.text).toBe(canonicalJson(value));
        expect(inspectToolOutput(stores.kernel, `sha256:${"00".repeat(32)}`)).toEqual({
          kind: "unknown_output",
          outputId: `sha256:${"00".repeat(32)}`,
        });

        // A repeated identical result re-projects to the SAME identifier.
        const again = yield* runTool(authority, value);
        expect(again.terminal).toBe("executed");
        const rows = resultRows();
        const lastRef = plainObject(plainObject(plainObject(rows.at(-1)?.effect.value).result).outputRef);
        expect(lastRef.outputId).toBe(outputId);
      }),
    ));

  it("the budget folds from generation settings; absent means the 32768-byte core default", () =>
    isolated(
      Effect.gen(function* () {
        materializeSession(stores.kernel, SESSION);
        const authority = adoptWriter(stores.kernel, SESSION);
        const smallValue: PlainValue = { status: "ok", output: "s".repeat(1_000) };
        // Under the default budget: the row carries the value verbatim.
        const first = yield* runTool(authority, smallValue);
        expect(first.terminal).toBe("executed");
        const verbatim = resultRows().at(-1);
        expect(plainObject(plainObject(verbatim?.effect.value).result)).toEqual(smallValue);

        // Pin a 200-byte budget through the configure settings row (#1253 fold).
        const parentId = stores.kernel.latestAction(SESSION)?.id ?? null;
        yield* kernelLedger(authority).commit(
          configureAction({
            id: `${SESSION}:configure-budget`,
            sessionId: SESSION,
            parentId,
            operation: "compose",
            snapshot: stores.kernel.latestGenerationFor(SESSION),
            settings: { steering: "all", followUp: "all", toolOutputBudgetBytes: 200 },
            at: testNow(),
          }),
        );
        expect(consumptionSettings(stores.kernel, SESSION).toolOutputBudgetBytes).toBe(200);
        const second = yield* runTool(authority, smallValue);
        expect(second.terminal).toBe("executed");
        const projected = resultRows().at(-1);
        const ref = plainObject(plainObject(plainObject(projected?.effect.value).result).outputRef);
        expect(ref.outputId).toBe(canonicalDigest(smallValue));
        expect(ref.bytes).toBe(Buffer.byteLength(canonicalJson(smallValue), "utf8"));
      }),
    ));
});
