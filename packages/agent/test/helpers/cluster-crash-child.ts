/**
 * W5.2 L2.4 — entity-crash child process (W5.1 check2 ported to the real
 * Session entity). Usage:
 *
 *   bun test/helpers/cluster-crash-child.ts <sessionsDir> <catalogFile> <sessionId> crash|restart
 *
 * crash:   boots the cluster runtime with a turn runner that reports entry and
 *          then blocks forever. The entity's `deliver` handler has already
 *          committed the received chain action when the runner starts, so the
 *          child prints "APPENDED turn=<id>" and keeps the envelope
 *          unacknowledged until the parent SIGKILLs this process.
 * restart: boots the runtime on the SAME files with a completing runner. The
 *          crashed envelope is redelivered from SqlMessageStorage; the chain
 *          dedupes it (action.id = messageId, plan D3). Prints REDELIVERED
 *          (dedupe evidence), SHAPES (real turn action kinds, F12 chain-level
 *          proxy), and DELIVER_AT (a deadline alarm occurrence's residual
 *          against its not-before instant).
 *
 * All Effects run through the allowlisted `runAgent` helper.
 */
import { Effect } from "effect";
import {
  blockingRunner,
  clusterMessages,
  readChain,
  resolvedRunner,
  runCluster,
  sendDeadline,
  sendPrompt,
  sessionFileFor,
  verifyChain,
  waitUntil,
} from "./cluster-runtime";

const CRASH_MESSAGE_ID = "crash-m1";

function usage(): never {
  console.error(
    "usage: bun test/helpers/cluster-crash-child.ts <sessionsDir> <catalogFile> <sessionId> crash|restart",
  );
  process.exit(2);
}

const [sessionsDir, catalogFile, sessionId, mode] = process.argv.slice(2);
if (
  sessionsDir === undefined ||
  catalogFile === undefined ||
  sessionId === undefined ||
  (mode !== "crash" && mode !== "restart")
) {
  usage();
}

const sessionFile = sessionFileFor(sessionsDir, sessionId);

if (mode === "crash") {
  // The deliver ack never arrives (the runner blocks forever); the process
  // stays alive inside runCluster until the parent SIGKILLs it.
  await runCluster(
    {
      sessionsDir,
      catalogFile,
      runner: blockingRunner((turnId) => {
        console.log(`APPENDED turn=${turnId} message=${CRASH_MESSAGE_ID}`);
      }),
    },
    Effect.gen(function* () {
      yield* Effect.forkScoped(sendPrompt(sessionId, CRASH_MESSAGE_ID, "crash me"));
      yield* Effect.never;
    }),
  );
} else {
  await runCluster(
    { sessionsDir, catalogFile, runner: resolvedRunner("recovered") },
    Effect.gen(function* () {
      // 1. The unacknowledged envelope from the crashed process is redelivered
      //    and processed on this runner (bounded DB-row wait, check2 pattern).
      yield* Effect.promise(() =>
        waitUntil(
          "crashed Session envelope processed after restart",
          () => clusterMessages(catalogFile, "Session").some((row) => row.processed === 1),
          30_000,
        ),
      );

      // 2. The chain deduped the replay: exactly one action for the messageId.
      const appended = readChain(sessionFile, sessionId).filter(
        (row) => row.id === CRASH_MESSAGE_ID,
      );
      const first = appended[0];
      if (appended.length !== 1 || first === undefined) {
        throw new Error(`expected one chain row for ${CRASH_MESSAGE_ID}, got ${appended.length}`);
      }
      console.log(
        `REDELIVERED count=${appended.length} ordinal=${first.ordinal} action_hash=${first.action_hash}`,
      );

      // 3. Real action shapes committed by the entity turn (F12 chain-level
      //    evidence) and the whole chain re-verifies hash-by-hash. The turn
      //    seal commits after the runner resolves, so await it durably.
      yield* Effect.promise(() =>
        waitUntil(
          "turn actions sealed on the chain",
          () => readChain(sessionFile, sessionId).some((row) => row.kind === "turn"),
          30_000,
        ),
      );
      const kinds = readChain(sessionFile, sessionId).map((row) => row.kind);
      console.log(`SHAPES count=${kinds.length} kinds=${kinds.join(",")}`);
      console.log(`CHAIN_OK ${verifyChain(sessionFile, sessionId)}`);

      // 4. DeliverAt: a deadline occurrence for an unknown request folds to a
      //    recorded stale alarm fact (#1253), but must not be handed to the
      //    entity before its not-before instant.
      const tSend = Date.now();
      yield* sendDeadline(sessionId, "no-such-request", tSend + 1500);
      console.log(`DELIVER_AT residual_ms=${Date.now() - tSend}`);
    }),
  );
  process.exit(0);
}
