import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { CompactionSeam } from "../../src/core/api";
import { applyCompaction } from "../../src/core/compaction";
import { commitFoldBatch } from "../../src/core/commit";
import { AgentFailure, AgentInvariantViolation } from "../../src/core/failure";
import { createRunState } from "../../src/core/turn";
import { foldSessionHistory, hydrateSessionHistory } from "../../src/inspect/history";
import { Compaction, compactionCapability, compactionSeamService } from "../../src/plugins/compaction";
import { estimateMessagesTokens } from "../../src/plugins/compaction/estimate";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import { resolveCompactionGeometry } from "../../src/plugins/compaction/geometry";
import { measuredContextTokens } from "../../src/plugins/compaction/measure";
import { prepareCompactionRestore } from "../../src/plugins/compaction/restore";
import { collector } from "../helpers/observation-collector";
import { fixtureCompactionSeam } from "../helpers/fixture-compaction";
import { fencedTurnFixture } from "../helpers/fenced-writer";
import { isolated, runTestPromise } from "../helpers/isolated";
import { testMessageSource } from "../helpers/message-source";
import { runInput } from "../helpers/run-input";

const history = { fold: foldSessionHistory, hydrate: hydrateSessionHistory };

describe("compaction capability contract (#1307)", () => {
  it("declares the seam service as its verbs: no kind, no point, no input, no tool", () => {
    const definition = compactionCapability(history);
    expect(definition.contract).toBe("capability");
    expect(definition.name).toBe("compaction");
    expect(definition.requires).toEqual([]);
    expect(Object.keys(definition.kinds)).toEqual([]);
    expect(definition.inputs).toEqual([]);
    expect(definition.points).toEqual([]);
    expect(definition.seam).toBe(CompactionSeam);
  });

  it("publishes exactly the module exports the kernel used to import, frozen", () => {
    const service = compactionSeamService(history);
    expect(Object.isFrozen(service)).toBe(true);
    expect(service.geometry).toBe(resolveCompactionGeometry);
    expect(service.measure).toBe(measuredContextTokens);
    expect(service.estimate).toBe(estimateMessagesTokens);
    expect(service.shouldCompact).toBe(Compaction.shouldCompact);
    expect(service.execute).toBe(executeCompaction);
    expect(service.prepareRestore).toBe(prepareCompactionRestore);
    expect(service.protectRecent).toBe(6);
  });
});

describe("compaction disabled: the kernel skips and records nothing new (#1307)", () => {
  it("applyCompaction without a seam returns none and publishes no event", async () => {
    const events = collector();
    const state = createRunState(runInput([{ role: "user", content: "hi" }]), testMessageSource());
    state.lastCallContextTokens = 999_999;
    const outcome = await isolated(
      applyCompaction(
        state,
        {
          events,
          model: { provider: "p", id: "m" },
          compaction: { contextWindowTokens: 100, onSummarize: () => Effect.succeed("s") },
        },
        { traceId: "t", sessionId: state.sessionId, runId: "r" },
        undefined,
        "threshold",
      ),
    );
    expect(outcome).toBe("none");
    expect(events.events.length).toBe(0);
  });

  it("a compaction append without the seam dies typed instead of committing unpinned", async () => {
    const exit = await isolated(({ kernel }) =>
      Effect.gen(function* () {
        const opened = yield* fencedTurnFixture(kernel, { id: "no-seam", clock: () => 1 });
        const row = kernel.row("no-seam");
        return yield* Effect.exit(
          commitFoldBatch(kernel, {
            sessionId: "no-seam",
            owner: opened.owner,
            fence: opened.fence,
            now: 2,
            expectedRevision: row.revision,
            actions: [
              {
                id: "compaction-1",
                parentId: kernel.latestAction("no-seam")?.id ?? null,
                sessionId: "no-seam",
                kind: "compaction",
                op: "compact",
                intent: { encodingVersion: 1, value: { phase: "intent" } },
                effect: { encodingVersion: 1, value: {} },
                ts: 2,
              },
            ],
            state: row.state,
          }),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const defect = Exit.isFailure(exit) ? exit.cause : undefined;
    expect(String(defect)).toContain("compaction append without a composed compaction seam");
  });

  it("prepareRestore refuses a foreign or absent intent typed, never improvises", async () => {
    const refused = await runTestPromise(
      Effect.flip(
        fixtureCompactionSeam.prepareRestore({
          sessionId: "restore-session",
          compactionId: "missing",
          action: undefined,
          result: undefined,
          history: [],
        }),
      ),
    );
    expect(refused).not.toBeInstanceOf(AgentFailure);
    expect(refused).not.toBeInstanceOf(AgentInvariantViolation);
    expect((refused as { reason?: string }).reason).toBe("unknown_compaction");
  });
});
