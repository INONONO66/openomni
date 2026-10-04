import { spawn } from "node:child_process";
import { Deferred, Effect, Exit } from "effect";
import { z } from "zod";
import { MachinesFailure, SpawnFailure, type MachineError } from "./errors";
import { createControlDecoder } from "./pty-decode";

/**
 * One tmux control-mode client per daemon (#1273): a `tmux -C` child whose
 * stdin carries commands and whose stdout interleaves `%begin`/`%end` reply
 * blocks with `%output` records. Replies answer strictly in command order, so
 * one FIFO of pending commands is the whole correlation state. Server exit
 * (`%exit` or stream close) fails every pending command deterministically.
 */
const spawnFailure = z
  .preprocess(String, z.string())
  .transform((cause) => new SpawnFailure({ operation: "pty.spawn", message: cause, cause })).parse;

/** A tmux command that produced no reply within this bound is a wedged server. */
const COMMAND_TIMEOUT_MS = 10_000;

interface PtyControlOptions {
  readonly argv: readonly [string, ...string[]];
  readonly onOutput: (paneId: string, data: Buffer) => void;
  /** A malformed control record: the affected pane's next read must fail visibly. */
  readonly onMalformed: (paneId: string | undefined, reason: string) => void;
  readonly onExit: () => void;
}

export interface PtyControl {
  /** Send one tmux command; resolves with the reply body lines, `%error` fails. */
  command(line: string): Effect.Effect<string[], MachineError>;
  close(): Effect.Effect<void, MachineError>;
}

export type PtyControlFactory = (options: PtyControlOptions) => Effect.Effect<PtyControl, MachineError>;

interface PendingReply {
  readonly done: Deferred.Deferred<string[], MachineError>;
  readonly lines: string[];
}

export const startPtyControl: PtyControlFactory = (options) =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () => spawn(options.argv[0], options.argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] }),
      catch: spawnFailure,
    });
    const decoder = createControlDecoder();
    const pending: PendingReply[] = [];
    let exited = false;
    const lost = (operation: string) => new MachinesFailure({ operation, cause: "tmux control client is gone" });
    function settleAll(error: MachineError): void {
      for (const reply of pending.splice(0)) Deferred.doneUnsafe(reply.done, Exit.fail(error));
    }
    function finish(): void {
      if (exited) return;
      exited = true;
      settleAll(lost("pty.command"));
      options.onExit();
    }
    function handleEnd(ok: boolean): void {
      const reply = pending.shift();
      if (reply === undefined) return;
      Deferred.doneUnsafe(
        reply.done,
        ok
          ? Exit.succeed(reply.lines)
          : Exit.fail(new MachinesFailure({ operation: "pty.command", cause: reply.lines.join("\n") || "tmux refused the command" })),
      );
    }
    function route(event: ReturnType<typeof decoder.feed>[number]): void {
      if (event.kind === "reply-body") pending[0]?.lines.push(event.line);
      else if (event.kind === "reply-end") handleEnd(event.ok);
      else if (event.kind === "output") options.onOutput(event.paneId, event.data);
      else if (event.kind === "malformed") options.onMalformed(event.paneId, event.reason);
      else if (event.kind === "exit") finish();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      for (const event of decoder.feed(chunk)) route(event);
    });
    child.once("error", finish);
    child.once("close", finish);
    // The attach itself answers with one empty %begin/%end block; consume it
    // so later replies line up with their commands.
    const ready = yield* Deferred.make<string[], MachineError>();
    pending.push({ done: ready, lines: [] });
    const bounded = (reply: Deferred.Deferred<string[], MachineError>, operation: string) =>
      Deferred.await(reply).pipe(
        Effect.timeoutOption(COMMAND_TIMEOUT_MS),
        Effect.flatMap((result) =>
          result._tag === "None"
            ? Effect.fail(new MachinesFailure({ operation, cause: "tmux did not answer within the command deadline" }))
            : Effect.succeed(result.value),
        ),
      );
    yield* bounded(ready, "pty.attach");
    return {
      command: (line) =>
        Effect.suspend(() => {
          if (exited) return Effect.fail(lost("pty.command"));
          return Effect.gen(function* () {
            const done = yield* Deferred.make<string[], MachineError>();
            pending.push({ done, lines: [] });
            yield* Effect.try({ try: () => void child.stdin.write(`${line}\n`), catch: spawnFailure });
            return yield* bounded(done, "pty.command");
          });
        }),
      close: () =>
        Effect.sync(() => {
          exited = true;
          settleAll(lost("pty.close"));
          child.kill("SIGKILL");
        }),
    };
  });
