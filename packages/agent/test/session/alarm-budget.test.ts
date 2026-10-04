/**
 * #1254 S4 D3 — the per-session armed-alarm budget, against the REAL entity:
 * a capability wake arming through `ctx.arm` succeeds until the durable armed
 * index holds `maxArmed` rows, then receives the typed
 * `ArmRefused{code: alarm_budget}` — and reserved purposes are refused with
 * `reserved_purpose` regardless of budget headroom. At a full budget a re-arm
 * of an armed chain (upsert) and a retire (`at: null`, delete) still commit —
 * only an arm that adds a chain consults the budget — and the retire frees one
 * slot. The same wake commits one alarm-originated prompt through `ctx.prompt`
 * (origin fixed by the core).
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect, Result } from "effect";
import { armAction, type AlarmCapability, type ArmRefused } from "../../src/core/alarm";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { clusterTempDir, runCluster, sendAlarm, sessionFileFor } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-alarm-budget-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionId = "budget-session";
const MAX_ARMED = 64;
const FAR_FUTURE = 4_102_444_800_000;

// Non-empty on purpose: the resent occurrence must carry the arm's payload as
// JSON bytes a capability can parse (`{}` would pass under any serializer).
const BOOT_PAYLOAD = { reason: "boot", attempt: 1, tags: ["a", "b"] };

test("ctx.arm fills the budget to maxArmed, then ArmRefused{alarm_budget}; re-arm/retire pass at full budget; reserved purposes always refuse", async () => {
  // Seed: one committed boot arm (purpose test.tick) whose resent occurrence
  // triggers the capability wake on activation.
  const boot = await runAgent(
    Effect.gen(function* () {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      yield* kernel.materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${sessionId}:materialize`,
        at: 1,
      });
      catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
      const fence = catalog.rotateFence(sessionId);
      yield* kernel.adoptFence({ sessionId, owner: "seeder", fence });
      const row = kernel.row(sessionId);
      const armed = armAction({
        parentId: `${sessionId}:materialize`,
        sessionId,
        purpose: "test.tick",
        at: 100,
        supersedes: null,
        alarmId: "boot",
        sourceKey: "boot",
        payload: BOOT_PAYLOAD,
        armSeq: row.revision + 1,
        ts: 100,
      });
      yield* kernel.commit({
        sessionId,
        owner: "seeder",
        fence,
        now: 100,
        expectedRevision: row.revision,
        actions: [armed.action],
        state: row.state,
      });
      store.close();
      catalog.close();
      return armed;
    }),
  );

  // The wake arms until refused; results surface through this settled promise.
  interface WakeReport {
    readonly armed: number;
    readonly refusal: ArmRefused | undefined;
    readonly reserved: ArmRefused | undefined;
    /** At the full budget: re-arm of tick-0, retire of tick-1, then one new chain. */
    readonly atFull: {
      readonly rearm: ArmRefused | { readonly alarmId: string; readonly armSeq: number };
      readonly retire: ArmRefused | { readonly alarmId: string };
      readonly freed: ArmRefused | { readonly alarmId: string };
    };
    readonly prompt: { readonly seq: number };
    readonly fired: {
      readonly occurrenceId: string;
      readonly alarmId: string;
      readonly payload: string;
    };
  }
  let resolveReport: (report: WakeReport) => void = () => undefined;
  const report = new Promise<WakeReport>((resolve) => {
    resolveReport = resolve;
  });
  const capability: AlarmCapability = {
    purposes: ["test.tick"],
    wake: (fired, ctx) =>
      Effect.gen(function* () {
        const prompt = yield* ctx.prompt({ content: "WAKE tick", payload: { detail: "line:1" } });
        const reserved = yield* Effect.result(
          ctx.arm({ purpose: "retry", at: FAR_FUTURE, payload: {}, sourceKey: "t" }),
        );
        let armed = 0;
        let refusal: ArmRefused | undefined;
        // The boot row occupies one slot until its fired fact retires it, so
        // headroom is maxArmed - 1; the next attempt crosses the budget.
        for (let index = 0; index < MAX_ARMED; index += 1) {
          const outcome = yield* Effect.result(
            ctx.arm({
              purpose: "test.tick",
              at: FAR_FUTURE + index,
              payload: { index },
              alarmId: `tick-${index}`,
              sourceKey: "t",
            }),
          );
          if (Result.isFailure(outcome)) {
            refusal = outcome.failure;
            break;
          }
          armed += 1;
        }
        const settle = <A>(outcome: Result.Result<A, ArmRefused>) =>
          Result.isFailure(outcome) ? outcome.failure : outcome.success;
        const rearm = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: FAR_FUTURE + 1_000, payload: {}, alarmId: "tick-0", sourceKey: "t" }),
          ),
        );
        const retire = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: null, payload: {}, alarmId: "tick-1", sourceKey: "t" }),
          ),
        );
        const freed = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: FAR_FUTURE, payload: {}, alarmId: "tick-freed", sourceKey: "t" }),
          ),
        );
        resolveReport({
          armed,
          refusal,
          reserved: Result.isFailure(reserved) ? reserved.failure : undefined,
          atFull: { rearm, retire, freed },
          prompt,
          fired: {
            occurrenceId: fired.occurrenceId,
            alarmId: fired.alarmId,
            payload: fired.payload,
          },
        });
        return "delivered" as const;
      }),
  };

  const outcome = await runCluster(
    { sessionsDir, catalogFile, alarmCapability: capability },
    Effect.gen(function* () {
      // Any occurrence activates the entity; activation resends the boot arm,
      // whose delivery runs the wake above.
      yield* sendAlarm(sessionId, {
        occurrenceId: "kick",
        purpose: "rescan",
        alarmId: "kick",
        armSeq: 1,
        sourceKey: "rescan",
        payload: "{}",
        fireAt: Date.now() - 1,
      });
      return yield* Effect.promise(() => report);
    }),
  );

  expect(outcome.reserved?.code).toBe("reserved_purpose");
  expect(outcome.armed).toBe(MAX_ARMED - 1);
  expect(outcome.refusal?.code).toBe("alarm_budget");
  // Full budget: the upsert and the delete commit (neither adds a row); the
  // retire frees exactly one slot for a new chain.
  expect(outcome.atFull.rearm).toMatchObject({ alarmId: "tick-0" });
  expect(outcome.atFull.retire).toMatchObject({ alarmId: "tick-1" });
  expect(outcome.atFull.freed).toMatchObject({ alarmId: "tick-freed" });

  // Durable index after the wake: the boot row retired on `fired{delivered}`,
  // the 63 accepted arms remain; the wake's prompt is one `prompt` row keyed
  // by the fired occurrence with the core-fixed alarm origin.
  const after = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => Date.now() });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), {
        now: () => Date.now(),
      });
      try {
        const kernel = SessionHandleStore.createSessionKernel(store, catalog);
        return {
          armed: kernel.armedAlarms(),
          prompt: kernel.actionById(`${outcome.fired.occurrenceId}:prompt`),
        };
      } finally {
        store.close();
        catalog.close();
      }
    }),
  );
  expect(after.armed.find((row) => row.occurrenceId === boot.occurrenceId)).toBeUndefined();
  // 63 accepted arms − retired tick-1 + tick-freed; tick-0 moved to its re-arm.
  expect(after.armed).toHaveLength(MAX_ARMED - 1);
  expect(after.armed.find((row) => row.alarmId === "tick-1")).toBeUndefined();
  expect(after.armed.find((row) => row.alarmId === "tick-freed")).toBeDefined();
  expect(after.armed.find((row) => row.alarmId === "tick-0")?.fireAt).toBe(FAR_FUTURE + 1_000);
  expect(outcome.fired.alarmId).toBe("boot");
  expect(JSON.parse(outcome.fired.payload)).toEqual(BOOT_PAYLOAD);
  expect(after.prompt?.kind).toBe("prompt");
  expect(after.prompt?.ordinal).toBe(outcome.prompt.seq);
  expect(after.prompt?.effect.value).toMatchObject({ content: "WAKE tick" });
  expect(after.prompt?.intent.value).toMatchObject({
    kind: "alarm",
    alarmId: "boot",
    occurrenceId: outcome.fired.occurrenceId,
    purpose: "test.tick",
    sourceKey: "boot",
    payload: { detail: "line:1" },
  });
});
