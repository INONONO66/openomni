import { Deferred, Effect, Schema, type Scope } from "effect";
import { z } from "zod";
import { PlainValueSchema, type PlainValue } from "@openomni/protocol";

/**
 * The hook capability's scoped process service (#1256): one external hook
 * process per composed generation, spoken to over JSON lines — one stdin
 * request line `{id, point, event, decisionInput}`, one stdout response line
 * `{id, result}`. The PID rides the acquiring Scope (the generation's
 * lifetime): sequential finalizers first await the last in-flight call, then
 * kill the PID — a rotation never cuts a running turn's call short. Process
 * state is never journaled; a restart simply spawns anew. Every failure maps
 * to a typed outcome carrying the existing `hook_timeout` failure code — the
 * verdict vocabulary is never widened and nothing continues on error.
 */

/** The composed `how.ref` target the hook capability registers (#1256). */
export const HOOK_PROCESS_REF = "hook/process";

/**
 * H-2 (#1256 r2): the stdout framing bound. A single response line (or an
 * unterminated buffer) larger than this is a framing violation: the process
 * is declared poisoned, every in-flight call settles `failure("framing")`
 * (deny at the gate) and the PID is killed — stdout buffering never grows
 * without bound on a hook that misbehaves.
 */
const HOOK_MAX_LINE_BYTES = 64 * 1024;

/** The gate vocabulary a hook result must use; anything else is a framing failure. */
export const HookGateVerdict = z.enum(["allow", "deny", "require_approval"]);
export type HookGateVerdict = z.infer<typeof HookGateVerdict>;

/** The decoded result variants one stdout line may carry. */
const HookResult = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gate"),
    verdict: HookGateVerdict,
    reason: z.string().min(1).optional(),
  }),
  /** Partial object restricted by the consuming row's declared rewritable fields. */
  z.strictObject({ type: z.literal("rewrite"), fields: z.record(z.string(), PlainValueSchema) }),
  /** Audit-only annotation payload for observe rows. */
  z.strictObject({ type: z.literal("observe"), payload: PlainValueSchema }),
]);

const HookResponseLine = z.strictObject({ id: z.string().min(1), result: HookResult });

/** One request the capability writes as a single stdin JSON line. */
export interface HookCallInput {
  readonly id: string;
  readonly point: string;
  readonly event: string;
  readonly decisionInput: PlainValue;
}

/**
 * The typed outcome union: gate verdicts, rewrite partials and observe
 * annotations are the successes; timeout, malformed framing (including a
 * verdict outside the vocabulary) and process death all map to the one
 * `hook_timeout`-coded failure a gate row journals as `deny{bundle_failure}`
 * and an observe row records as an audit fact.
 */
export type HookOutcome =
  | { readonly kind: "gate"; readonly verdict: HookGateVerdict; readonly reason?: string }
  | { readonly kind: "rewrite"; readonly fields: Readonly<Record<string, PlainValue>> }
  | { readonly kind: "observe"; readonly payload: PlainValue }
  | {
      readonly kind: "failure";
      readonly code: "hook_timeout";
      readonly cause: "timeout" | "framing" | "exit";
    };

const failure = (cause: "timeout" | "framing" | "exit"): HookOutcome =>
  Object.freeze({ kind: "failure" as const, code: "hook_timeout" as const, cause });

/** A hook process that could not spawn: the generation is refused, never partially activated. */
export class HookSpawnError extends Schema.TaggedError<HookSpawnError>(
  "@openomni/agent/plugins/hook/HookSpawnError",
)("HookSpawnError", {
  command: Schema.Array(Schema.String),
  cause: Schema.String,
}) {}

export interface HookProcessConfig {
  /** The hook executable and its arguments, exactly as configured. */
  readonly command: readonly string[];
  /** Bounds ONE handler call via the Effect clock; there is no alarm timer. */
  readonly timeoutMs: number;
  /** Per-line/buffer byte bound on stdout framing; default `HOOK_MAX_LINE_BYTES`. */
  readonly maxLineBytes?: number;
}

/** The scoped service face: one live PID, one bounded call at a time semantics-free. */
export interface HookProcess {
  readonly pid: number;
  /** Calls in flight right now; the Scope finalizer drains this to zero before the kill. */
  readonly inFlight: () => number;
  call(input: HookCallInput): Effect.Effect<HookOutcome>;
  /** Settles with the exit code once the PID is gone. */
  readonly exited: Effect.Effect<number>;
}

interface Pending {
  readonly waiter: Deferred.Deferred<HookOutcome>;
}

function decodeLine(line: string): z.infer<typeof HookResponseLine> | undefined {
  try {
    const parsed = HookResponseLine.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function outcomeOf(result: z.infer<typeof HookResult>): HookOutcome {
  switch (result.type) {
    case "gate":
      return {
        kind: "gate",
        verdict: result.verdict,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    case "rewrite":
      return { kind: "rewrite", fields: result.fields };
    case "observe":
      return { kind: "observe", payload: result.payload };
  }
}

/**
 * Spawns the configured hook process inside the caller's Scope — the ONLY
 * process-spawning site of the hook path (`packages/agent/src/core` stays at
 * zero spawn hits). Finalizer order on Scope close: (1) await the last
 * in-flight call, (2) stop the stdout reader, (3) kill the PID and await its
 * exit — the old generation's PID dies only after its last in-flight call.
 */
export function acquireHookProcess(
  config: HookProcessConfig,
): Effect.Effect<HookProcess, HookSpawnError, Scope.Scope> {
  return Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [...config.command],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        }),
      catch: (cause) => new HookSpawnError({ command: config.command, cause: String(cause) }),
    });

    const pending = new Map<string, Pending>();
    let closing = false;
    let dead = false;
    const drained = yield* Deferred.make<void>();

    const settleDrained = (): void => {
      if (closing && pending.size === 0) Deferred.doneUnsafe(drained, Effect.void);
    };

    const settleAll = (outcome: HookOutcome): void => {
      const waiters = [...pending.values()];
      pending.clear();
      for (const entry of waiters) Deferred.doneUnsafe(entry.waiter, Effect.succeed(outcome));
      settleDrained();
    };

    const settleLine = (line: string): void => {
      const decoded = decodeLine(line);
      if (decoded === undefined) {
        // A malformed line poisons every in-flight call fail-closed: nothing
        // downstream can tell which request the garbage answered.
        settleAll(failure("framing"));
        return;
      }
      const entry = pending.get(decoded.id);
      if (entry === undefined) return;
      pending.delete(decoded.id);
      Deferred.doneUnsafe(entry.waiter, Effect.succeed(outcomeOf(decoded.result)));
      settleDrained();
    };

    // Finalizer (runs LAST): kill the PID and await its exit.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        child.kill();
        await child.exited;
      }),
    );

    // H-2: a framing-bound violation poisons the PID fail-closed — settle
    // everything as a framing failure, kill the child, accept no new calls.
    const maxLineBytes = config.maxLineBytes ?? HOOK_MAX_LINE_BYTES;
    const poisonFraming = (): void => {
      dead = true;
      settleAll(failure("framing"));
      child.kill();
    };

    // The stdout reader: one fiber per PID, interrupted after the drain.
    yield* Effect.forkScoped(
      Effect.promise(async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
            const line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            if (Buffer.byteLength(line, "utf8") > maxLineBytes) return poisonFraming();
            if (line.length > 0) settleLine(line);
          }
          // An unterminated line may never see its newline: bound the buffer too.
          if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) return poisonFraming();
        }
        // Stream end = the process died mid-conversation.
        dead = true;
        settleAll(failure("exit"));
      }),
    );

    // Finalizer (runs FIRST): the old PID survives until its last in-flight call.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closing = true;
        return pending.size === 0 ? Effect.void : Deferred.await(drained);
      }),
    );

    const call = (input: HookCallInput): Effect.Effect<HookOutcome> =>
      Effect.gen(function* () {
        if (dead || closing) return failure("exit");
        const waiter = yield* Deferred.make<HookOutcome>();
        pending.set(input.id, { waiter });
        const wrote = yield* Effect.try(() => {
          child.stdin.write(
            `${JSON.stringify({ id: input.id, point: input.point, event: input.event, decisionInput: input.decisionInput })}\n`,
          );
          child.stdin.flush();
        }).pipe(Effect.isSuccess);
        if (!wrote) {
          pending.delete(input.id);
          settleDrained();
          return failure("exit");
        }
        const settled = yield* Deferred.await(waiter).pipe(Effect.timeoutOption(config.timeoutMs));
        if (settled._tag === "Some") return settled.value;
        pending.delete(input.id);
        settleDrained();
        return failure("timeout");
      });

    return {
      pid: child.pid,
      inFlight: () => pending.size,
      call,
      exited: Effect.promise(() => child.exited),
    };
  });
}
