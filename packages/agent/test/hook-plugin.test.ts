import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  acquireHookProcess,
  HOOK_PROCESS_REF,
  HookSpawnError,
  hookCapability,
  type HookOutcome,
  type HookProcess,
} from "../src/plugins/hook";
import { runTestPromise } from "./helpers/isolated";

/**
 * #1256 hook capability: the scoped JSON-lines process service. Every case
 * runs a REAL scripted child (bun -e) and synchronizes on stdout replies,
 * exit settlement or the TestClock — never on a fixed sleep.
 */

/** The scripted echo child: behavior is keyed by the request's `event` field. */
const CHILD_SCRIPT = `
const held = [];
let splitRest = "";
process.on("SIGUSR2", () => {
  for (const id of held.splice(0)) console.log(JSON.stringify({ id, result: { type: "gate", verdict: "allow" } }));
});
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const reply = (result) => console.log(JSON.stringify({ id: request.id, result }));
    switch (request.event) {
      case "allow": reply({ type: "gate", verdict: "allow" }); break;
      case "deny": reply({ type: "gate", verdict: "deny", reason: "secret" }); break;
      case "rewrite": reply({ type: "rewrite", fields: { input: { redacted: true } } }); break;
      case "observe": reply({ type: "observe", payload: { note: "seen" } }); break;
      case "garbage": console.log("not a json line"); break;
      case "bad-verdict": reply({ type: "gate", verdict: "maybe" }); break;
      case "hold": held.push(request.id); break;
      case "die": process.exit(7);
      case "silent": break;
      case "oversize": reply({ type: "gate", verdict: "allow", reason: "r".repeat(4096) }); break;
      case "unterminated": process.stdout.write("y".repeat(4096)); break;
      case "split": {
        const line = JSON.stringify({ id: request.id, result: { type: "gate", verdict: "allow" } }) + "\\n";
        splitRest = line.slice(6);
        process.stdout.write(line.slice(0, 6));
        break;
      }
      case "flush-split": process.stdout.write(splitRest); reply({ type: "gate", verdict: "allow" }); break;
    }
  }
}
`;

const COMMAND = [process.execPath, "-e", CHILD_SCRIPT] as const;

function request(event: string, id = event): Parameters<HookProcess["call"]>[0] {
  return { id, point: "tool.pre", event, decisionInput: { op: "bash" } };
}

const scoped = <A, E>(body: (scope: Scope.Scope) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const result = yield* body(scope).pipe(Effect.onExit(() => Scope.close(scope, Exit.void)));
    return result;
  });

/** Cooperative wait for a synchronously-observable condition; no clock involved. */
const settledWhen = (condition: () => boolean) =>
  Effect.gen(function* () {
    while (!condition()) yield* Effect.yieldNow;
  });

test("the capability declares exactly one handler and no kind, point, input or tool", () => {
  const capability = hookCapability();
  expect(capability.name).toBe("hook");
  expect(capability.requires).toEqual(["action"]);
  expect(Object.keys(capability.handlers)).toEqual([HOOK_PROCESS_REF]);
  expect(Object.keys(capability.kinds)).toEqual([]);
  expect(capability.points).toEqual([]);
  expect(capability.inputs).toEqual([]);
});

test("allow, deny, rewrite and observe results round-trip over JSON lines", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 60_000 }).pipe(
          Scope.provide(scope),
        );
        expect(yield* hook.call(request("allow"))).toEqual({ kind: "gate", verdict: "allow" });
        expect(yield* hook.call(request("deny"))).toEqual({
          kind: "gate",
          verdict: "deny",
          reason: "secret",
        });
        expect(yield* hook.call(request("rewrite"))).toEqual({
          kind: "rewrite",
          fields: { input: { redacted: true } },
        });
        expect(yield* hook.call(request("observe"))).toEqual({
          kind: "observe",
          payload: { note: "seen" },
        });
        expect(hook.inFlight()).toBe(0);
      }),
    ),
  ));

test("a non-JSON line and a verdict outside the vocabulary both fail as framing", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 60_000 }).pipe(
          Scope.provide(scope),
        );
        expect(yield* hook.call(request("garbage"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "framing",
        });
        expect(yield* hook.call(request("bad-verdict"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "framing",
        });
      }),
    ),
  ));

test("the process dying during a call settles the call as an exit failure", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 60_000 }).pipe(
          Scope.provide(scope),
        );
        expect(yield* hook.call(request("die"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "exit",
        });
        expect(yield* hook.exited).toBe(7);
        // A dead PID refuses further calls without hanging.
        expect(yield* hook.call(request("allow"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "exit",
        });
      }),
    ),
  ));

test("a nonresponsive script times out when the TestClock passes timeoutMs", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 5_000 }).pipe(
          Scope.provide(scope),
        );
        const call = yield* Effect.forkChild(hook.call(request("silent")));
        yield* settledWhen(() => hook.inFlight() === 1);
        yield* TestClock.adjust(5_001);
        expect(yield* Fiber.join(call)).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "timeout",
        });
        expect(hook.inFlight()).toBe(0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

test("rotation: one PID per generation and the old PID dies only after its last in-flight call", () =>
  runTestPromise(
    Effect.gen(function* () {
      const oldScope = yield* Scope.make();
      const oldHook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 60_000 }).pipe(
        Scope.provide(oldScope),
      );
      // A full round-trip proves the child is up with its signal handler bound.
      expect(yield* oldHook.call(request("allow"))).toEqual({ kind: "gate", verdict: "allow" });
      // One turn is mid-call against the generation it captured.
      const inFlightCall = yield* Effect.forkChild(oldHook.call(request("hold")));
      yield* settledWhen(() => oldHook.inFlight() === 1);
      // The manifest changes: a NEW generation composes with its own PID while
      // the old Scope's close parks on the in-flight call.
      const closing = yield* Effect.forkChild(Scope.close(oldScope, Exit.void));
      const result = yield* scoped((scope) =>
        Effect.gen(function* () {
          const newHook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 60_000 }).pipe(
            Scope.provide(scope),
          );
          expect(newHook.pid).not.toBe(oldHook.pid);
          // Release the held reply: the old turn finishes on its captured PID.
          process.kill(oldHook.pid, "SIGUSR2");
          const outcome: HookOutcome = yield* Fiber.join(inFlightCall);
          yield* Fiber.join(closing);
          // The old PID is dead only AFTER the call settled with a real verdict.
          yield* oldHook.exited;
          expect(outcome).toEqual({ kind: "gate", verdict: "allow" });
          return yield* newHook.call(request("allow"));
        }),
      );
      // The new generation's PID kept serving throughout the rotation.
      expect(result).toEqual({ kind: "gate", verdict: "allow" });
    }),
  ));

test("a missing executable is a typed spawn refusal, never a partial activation", () =>
  runTestPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* acquireHookProcess({
          command: ["/nonexistent-hook-executable-1256"],
          timeoutMs: 1_000,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HookSpawnError);
        expect(error.command).toEqual(["/nonexistent-hook-executable-1256"]);
      }),
    ),
  ));

test("H-2: a response line over maxLineBytes poisons the PID as a framing failure", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({
          command: COMMAND,
          timeoutMs: 60_000,
          maxLineBytes: 1024,
        }).pipe(Scope.provide(scope));
        expect(yield* hook.call(request("oversize"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "framing",
        });
        // The poisoned PID was killed and refuses further calls without hanging.
        yield* hook.exited;
        expect(yield* hook.call(request("allow"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "exit",
        });
      }),
    ),
  ));

test("H-2: an unterminated buffer over maxLineBytes poisons the PID as a framing failure", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({
          command: COMMAND,
          timeoutMs: 60_000,
          maxLineBytes: 1024,
        }).pipe(Scope.provide(scope));
        // The child floods 4096 bytes with NO newline: the buffer bound trips
        // without ever completing a line, and the pending call settles framing.
        expect(yield* hook.call(request("unterminated"))).toEqual({
          kind: "failure",
          code: "hook_timeout",
          cause: "framing",
        });
        yield* hook.exited;
      }),
    ),
  ));

test("M-1: one JSON line split across two stdout writes decodes once complete", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const hook = yield* acquireHookProcess({ command: COMMAND, timeoutMs: 60_000 }).pipe(
          Scope.provide(scope),
        );
        // The child answers "split" with the FIRST 6 bytes of its response line
        // (no newline) and holds the rest until the next request arrives, so
        // the parent reader observes a frame boundary inside one JSON line.
        const splitCall = yield* Effect.forkChild(hook.call(request("split")));
        yield* settledWhen(() => hook.inFlight() === 1);
        expect(yield* hook.call(request("flush-split"))).toEqual({
          kind: "gate",
          verdict: "allow",
        });
        expect(yield* Fiber.join(splitCall)).toEqual({ kind: "gate", verdict: "allow" });
        expect(hook.inFlight()).toBe(0);
      }),
    ),
  ));
