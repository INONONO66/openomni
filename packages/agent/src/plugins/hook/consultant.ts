import { canonicalDigest, type PlainValue } from "@openomni/protocol";
import { Effect, type Scope } from "effect";
import { z } from "zod";
import type {
  ConsultantSeed,
  ConsultInput,
  GateHandlerResult,
  NamedConsultant,
} from "../../core/api";
import {
  acquireHookProcess,
  HOOK_PROCESS_REF,
  type HookOutcome,
  type HookProcess,
  type HookSpawnError,
} from "./process";

/**
 * The hook capability's gate consultant (#1256 r2, H-1): the named service a
 * composed `how.ref: "hook/process"` row consults. The composition acquires
 * it inside the generation Layer's Scope: every distinct command configured
 * on the generation's hook rows spawns its ONE PID eagerly, so a hook that
 * cannot spawn refuses the whole generation (typed candidate failure) instead
 * of partially activating. At decision time the consultant writes one JSON
 * request line and folds the typed outcome into the gate's prepared-result
 * channel — every failure (timeout, framing, exit, bad params) folds to deny
 * with `reason: "bundle_failure"`, never a widened verdict vocabulary.
 */

/** The row params a hooks product compiles onto a `hook/process` row. */
const HookRowParams = z.looseObject({
  event: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive(),
  maxLineBytes: z.number().int().positive().optional(),
});

function processKey(params: z.infer<typeof HookRowParams>): string {
  return canonicalDigest({
    command: params.command,
    timeoutMs: params.timeoutMs,
    maxLineBytes: params.maxLineBytes ?? null,
  });
}

function denyResult(cause: string): GateHandlerResult {
  return {
    verdict: "deny",
    payload: {
      ref: HOOK_PROCESS_REF,
      verdict: "deny",
      reason: "bundle_failure",
      code: "hook_timeout",
      cause,
    },
  };
}

/** Folds one typed process outcome into the gate's prepared handler result. */
function resultOf(outcome: HookOutcome): GateHandlerResult {
  switch (outcome.kind) {
    case "gate":
      return {
        verdict: outcome.verdict,
        payload: {
          ref: HOOK_PROCESS_REF,
          verdict: outcome.verdict,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        },
      };
    case "rewrite":
      return {
        value: outcome.fields,
        payload: { ref: HOOK_PROCESS_REF, output: canonicalDigest(outcome.fields) },
      };
    case "observe":
      return { payload: outcome.payload };
    case "failure":
      return denyResult(outcome.cause);
  }
}

/**
 * The `ConsultantHandler` factory the hook capability registers under
 * `hook/process`. Late results (H-3) re-enter through `seed.late` as action
 * rows via the composition's deliver door; a seed without the port drops them.
 */
/** Timed-out calls remembered for late correlation; older entries evict first. */
const LATE_WINDOW = 256;

/** The PlainValue rendering of a late outcome; failures are never late (they WERE the fold). */
function latePayloadOf(outcome: HookOutcome): PlainValue | undefined {
  switch (outcome.kind) {
    case "gate":
      return {
        type: "gate",
        verdict: outcome.verdict,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      };
    case "rewrite":
      return { type: "rewrite", fields: outcome.fields };
    case "observe":
      return { type: "observe", payload: outcome.payload };
    case "failure":
      return undefined;
  }
}

export function hookProcessConsultant(
  seed: ConsultantSeed,
): Effect.Effect<NamedConsultant["consult"], HookSpawnError, Scope.Scope> {
  return Effect.gen(function* () {
    // #1256 H-3: calls that timed out, keyed by wire id with the journal
    // cursor captured at CALL time — a late line re-enters the session as an
    // `action` row carrying that `after` cursor through `seed.late`.
    const timedOut = new Map<string, number | null>();
    const rememberTimeout = (id: string, after: number | null): void => {
      timedOut.set(id, after);
      for (const key of timedOut.keys()) {
        if (timedOut.size <= LATE_WINDOW) break;
        timedOut.delete(key);
      }
    };
    const routeLate = (late: { id: string; outcome: HookOutcome }): void => {
      if (!timedOut.has(late.id)) return;
      const after = timedOut.get(late.id);
      timedOut.delete(late.id);
      const result = latePayloadOf(late.outcome);
      if (result === undefined) return;
      seed.late?.({
        hook: HOOK_PROCESS_REF,
        id: late.id,
        result,
        ...(after === null ? {} : { after }),
      });
    };
    // One PID per distinct configured command, spawned EAGERLY in the
    // generation's Scope: a missing executable refuses the generation.
    const pool = new Map<string, HookProcess>();
    for (const row of seed.rows) {
      const params = HookRowParams.safeParse(row.how.params);
      if (!params.success) continue; // the row denies at consult time
      const key = processKey(params.data);
      if (pool.has(key)) continue;
      pool.set(
        key,
        yield* acquireHookProcess({
          command: params.data.command,
          timeoutMs: params.data.timeoutMs,
          ...(params.data.maxLineBytes === undefined
            ? {}
            : { maxLineBytes: params.data.maxLineBytes }),
          onLate: routeLate,
        }),
      );
    }
    let calls = 0;
    return (input: ConsultInput): Effect.Effect<GateHandlerResult> =>
      Effect.suspend(() => {
        const params = HookRowParams.safeParse(input.params);
        if (!params.success) return Effect.succeed(denyResult("invalid_params"));
        const hook = pool.get(processKey(params.data));
        if (hook === undefined) return Effect.succeed(denyResult("process_unavailable"));
        calls += 1;
        const id = `${input.rowId}#${calls}`;
        const after = seed.cursor?.() ?? null;
        return hook
          .call({
            id,
            point: input.point,
            event: params.data.event,
            decisionInput: input.value,
          })
          .pipe(
            Effect.map((outcome) => {
              if (outcome.kind === "failure" && outcome.cause === "timeout")
                rememberTimeout(id, after);
              return resultOf(outcome);
            }),
          );
      });
  });
}
