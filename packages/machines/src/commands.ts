import { spawn } from "node:child_process";
import { Deferred, Effect, Exit } from "effect";
import { z } from "zod";
import { SpawnFailure, type MachineError } from "./errors";

/** Output of one argv execution; stderr is kept for typed refusal mapping. */
export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injectable shell-out port (#1274): the computer-use adapter never spawns
 * directly, so unit tests substitute a fake runner and never touch the real
 * screen, keyboard, or TCC prompts. A missing binary surfaces as a
 * `SpawnFailure`, which the adapter maps to an availability refusal.
 */
export interface CommandRunner {
  run(argv: readonly [string, ...string[]]): Effect.Effect<CommandResult, MachineError>;
}

const spawnFailure = z
  .preprocess(String, z.string())
  .transform((cause) => new SpawnFailure({ operation: "command.spawn", message: cause, cause })).parse;

/** Bound on collected stdout/stderr text per command; sips/osascript output is small. */
const COMMAND_OUTPUT_MAX_BYTES = 262_144;

/** Real argv execution without a shell; image bytes travel via files, not pipes. */
export function systemCommandRunner(): CommandRunner {
  return {
    run: (argv) =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<CommandResult, MachineError>();
        const child = yield* Effect.try({
          try: () => spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] }),
          catch: spawnFailure,
        });
        let stdout = "";
        let stderr = "";
        let failed: SpawnFailure | undefined;
        const collect = (previous: string, chunk: Buffer) =>
          previous.length >= COMMAND_OUTPUT_MAX_BYTES
            ? previous
            : previous + chunk.toString("utf8", 0, COMMAND_OUTPUT_MAX_BYTES - previous.length);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = collect(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = collect(stderr, chunk);
        });
        child.once("error", (error) => {
          failed = spawnFailure(error);
        });
        child.once("close", (exitCode) => {
          Deferred.doneUnsafe(
            closed,
            failed ? Exit.fail(failed) : Exit.succeed({ exitCode, stdout, stderr }),
          );
        });
        return yield* Deferred.await(closed);
      }),
  };
}
