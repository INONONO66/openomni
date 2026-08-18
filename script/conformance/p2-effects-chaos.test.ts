/**
 * Seeded chaos bench over the effect substrate (#698 leaf 6, #494 prep).
 *
 * A deterministic PRNG drives randomized operation sequences — fresh runs
 * with confirmed/failed/unknown drivers, idempotency replays, crash-window
 * intents, reconcile sweeps — and NAMED INVARIANTS are asserted after every
 * iteration. Simple example-based pins cover the cases someone thought of;
 * the bench covers the interleavings nobody did. A failure prints the seed
 * and the operation log, so every red is replayable exactly.
 *
 * Invariants (each named, each independently falsifiable):
 *   I1 one-terminal    — an effect stream never carries two terminal
 *                        outcomes: confirmed XOR failed XOR still pending.
 *   I2 no-lost-intent  — every effectId ever intended is observable as
 *                        pending (outstanding) or terminal; none vanish.
 *   I3 no-silent-rerun — a terminal effectId never re-executes its driver
 *                        on replay; execution count per effectId is 1.
 *   I4 tag-stability   — the recorded replay tag equals the driver's
 *                        declaration on every observable intent.
 *
 * Seed override: CHAOS_SEED=<number> bun test script/conformance/p2-effects-chaos.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EffectManifest,
  EffectService,
  type EffectDriver,
  type EffectExecution,
} from "../../packages/openomni/src/effect/index";
import { EffectStore, SqliteStorageAdapter, Storage } from "../../packages/session/src/index";

const DEFAULT_SEED = 20260819;
const ITERATIONS = 200;
const MAX_OPS_PER_ITERATION = 12;

/** mulberry32 — tiny, deterministic, good-enough dispersion for op choice. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type DriverBehavior = "confirms" | "fails" | "unknown";

interface ChaosState {
  service: EffectService;
  executions: Map<string, number>;
  intended: Map<string, { behavior: DriverBehavior; replay: "never" | "safe" }>;
  opLog: string[];
}

function buildChaosRuntime(): ChaosState {
  const executions = new Map<string, number>();
  const manifest = new EffectManifest();
  const driverOf = (behavior: DriverBehavior, replay: "never" | "safe"): EffectDriver => ({
    kind: `chaos.${behavior}.${replay}`,
    replay,
    execute: (intent): EffectExecution => {
      executions.set(intent.effectId, (executions.get(intent.effectId) ?? 0) + 1);
      if (behavior === "confirms") return { kind: "confirmed", receipt: "chaos-ok" };
      if (behavior === "fails") return { kind: "failed", reason: "chaos-fail" };
      return { kind: "unknown", reason: "chaos-crash-window" };
    },
    // Probes never re-execute: reconcile resolves confirms/fails definitively
    // and leaves unknown outcome-less, mirroring the production contract.
    reconcile: (): EffectExecution => {
      if (behavior === "confirms") return { kind: "confirmed", receipt: "chaos-probe" };
      if (behavior === "fails") return { kind: "failed", reason: "chaos-probe-fail" };
      return { kind: "unknown", reason: "chaos-still-unknown" };
    },
  });
  for (const behavior of ["confirms", "fails", "unknown"] as const) {
    for (const replay of ["never", "safe"] as const) {
      manifest.register(driverOf(behavior, replay));
    }
  }
  return {
    service: new EffectService(manifest),
    executions,
    intended: new Map(),
    opLog: [],
  };
}

function assertInvariants(state: ChaosState, seed: number): void {
  const context = () => `seed=${seed}\nops:\n${state.opLog.join("\n")}`;
  const outstanding = EffectStore.outstandingIntents();
  const terminal = EffectStore.terminalIntents();
  const pendingIds = new Set(outstanding.map((intent) => intent.effectId));
  const terminalIds = new Map(terminal.map((row) => [row.intent.effectId, row.outcome]));

  // I1 one-terminal: pending and terminal are disjoint; the store's terminal
  // view carries exactly one outcome per id by construction — a stream that
  // were both pending and terminal would mean a second appended outcome.
  for (const id of pendingIds) {
    expect(terminalIds.has(id), `I1 one-terminal violated for ${id}\n${context()}`).toBe(false);
  }

  // I2 no-lost-intent: everything we ever intended is observable.
  for (const [id] of state.intended) {
    const observable = pendingIds.has(id) || terminalIds.has(id);
    expect(observable, `I2 no-lost-intent violated for ${id}\n${context()}`).toBe(true);
  }

  // I3 no-silent-rerun: replays and probes never re-execute a driver.
  for (const [id, count] of state.executions) {
    expect(count, `I3 no-silent-rerun violated for ${id} (count ${count})\n${context()}`).toBe(1);
  }

  // I4 tag-stability: the recorded tag is the driver's declaration.
  for (const row of terminal) {
    const meta = state.intended.get(row.intent.effectId);
    if (meta === undefined) continue;
    expect(
      row.intent.replay,
      `I4 tag-stability violated for ${row.intent.effectId}\n${context()}`,
    ).toBe(meta.replay);
  }
  for (const intent of outstanding) {
    const meta = state.intended.get(intent.effectId);
    if (meta === undefined) continue;
    expect(intent.replay, `I4 tag-stability violated for ${intent.effectId}\n${context()}`).toBe(
      meta.replay,
    );
  }
}

describe("p2 effects chaos bench", () => {
  let adapter: SqliteStorageAdapter | undefined;

  beforeEach(() => {
    adapter = new SqliteStorageAdapter(":memory:");
    Storage.configure(adapter);
  });

  afterEach(() => {
    Storage.reset();
    adapter?.close();
    adapter = undefined;
  });

  test(`${ITERATIONS} seeded iterations hold the four named invariants`, async () => {
    const seed = Number(process.env.CHAOS_SEED ?? DEFAULT_SEED);
    const random = prng(seed);
    const state = buildChaosRuntime();
    let nextEffect = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const ops = 1 + Math.floor(random() * MAX_OPS_PER_ITERATION);
      for (let op = 0; op < ops; op += 1) {
        const roll = random();
        if (roll < 0.6 || state.intended.size === 0) {
          // Fresh effect through the full record-before-act sequence.
          const behavior = (["confirms", "fails", "unknown"] as const)[
            Math.floor(random() * 3)
          ] as DriverBehavior;
          const replay = random() < 0.5 ? "never" : "safe";
          nextEffect += 1;
          const effectId = `chaos-${nextEffect}`;
          state.intended.set(effectId, { behavior, replay });
          state.opLog.push(`run fresh ${effectId} ${behavior}/${replay}`);
          await state.service.run({ effectId, kind: `chaos.${behavior}.${replay}` });
        } else {
          // Idempotency replay of a previously intended effect: terminal ids
          // must read back; pending ids go to the probe, never re-execution.
          const ids = [...state.intended.keys()];
          const effectId = ids[Math.floor(random() * ids.length)] as string;
          const meta = state.intended.get(effectId);
          if (meta === undefined) continue;
          state.opLog.push(`replay ${effectId}`);
          await state.service.run({
            effectId,
            kind: `chaos.${meta.behavior}.${meta.replay}`,
          });
        }
      }
      assertInvariants(state, seed);
      // Bound the op log so a late failure prints the recent window, not 2k lines.
      if (state.opLog.length > 60) state.opLog.splice(0, state.opLog.length - 60);
    }

    // Terminal census sanity: the bench actually exercised both classes.
    const terminal = EffectStore.terminalIntents();
    expect(terminal.length).toBeGreaterThan(0);
    expect(EffectStore.outstandingIntents().length).toBeGreaterThan(0);
  });
});
