import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { writeFileSync } from "node:fs";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  canonicalDigest,
  LedgerAction,
  Message,
  PlainValueSchema,
  SessionTurn,
} from "@openomni/protocol";
import { z } from "zod";
import { Effect } from "effect";
import { runAgent } from "./executor";
import { allowConfigure, withSessionServices, type SessionFixture } from "./session-services";
import { createExecutor } from "../../src/executor";
import { closeSessions, wakeSession } from "../../src/session-handle";
import {
  FoldCheckpointIntegrityError,
  foldHistoryState,
  foldSessionHistory,
  hydrateSessionHistory,
} from "../../src/session-lifecycle/history";
import { reconstructionFixture, reconstructionSession } from "./reconstruction-fixture";

export const reconstructionWitness = z.object({
  revision: z.number(),
  digest: z.string(),
  oracle: z.string(),
  stateDigest: z.string(),
  stateOracle: z.string(),
  ids: z.array(z.string()),
  history: z.array(Message.WithParts),
  checkpoint: LedgerAction.Node.optional(),
  actions: z.array(LedgerAction.Node),
  capture: z
    .object({
      context: SessionTurn.Context,
      toolsGeneration: z.number(),
      toolsHash: z.string(),
      systemHash: z.string(),
      history: z.array(Message.WithParts),
      messages: z.array(
        SessionTurn.Message.extend({ id: z.string().optional(), time: z.number().optional() }),
      ),
      recoveryUnchanged: z.boolean(),
    })
    .optional(),
});
type Witness = z.infer<typeof reconstructionWitness>;

function reconstructionSnapshot(): Witness {
  const actions = sessionTree(reconstructionSession);
  const hydrated = hydrateSessionHistory(reconstructionSession);
  return {
    revision: SessionHandleStore.row(reconstructionSession).revision,
    digest: canonicalDigest(hydrated.history),
    oracle: canonicalDigest(foldSessionHistory(reconstructionSession, actions)),
    stateDigest: canonicalDigest({ foldVersion: 1, state: PlainValueSchema.parse(hydrated.state) }),
    stateOracle: canonicalDigest({
      foldVersion: 1,
      state: PlainValueSchema.parse(foldHistoryState(reconstructionSession, actions)),
    }),
    ids: hydrated.history.map((message) => message.info.id),
    history: hydrated.history,
    checkpoint: actions.filter((action) => action.kind === "fold.checkpoint").at(-1),
    actions,
  };
}

export async function reconstructionMain(
  stage: string,
  dbPath: string,
  boundary?: (witness: Witness) => void,
): Promise<Witness> {
  Storage.initialize({ dbPath });
  if (stage === "write") {
    const fixture = await reconstructionFixture();
    await fixture.compact();
    await fixture.suffix();
  }
  const witness = reconstructionSnapshot();
  if (stage !== "wake") return witness;
  const runtime: SessionFixture = { observations: { publish: () => undefined }, clock: () => 100_000, authorizeConfigure: allowConfigure };
  return runAgent(Effect.scoped(withSessionServices(Effect.gen(function* () {
    yield* wakeSession(
      reconstructionSession,
      (input) => Effect.gen(function* () {
        const before = sessionTree(reconstructionSession);
        const executor = yield* createExecutor({
          ledger: input.ledger,
          identity: {
            sessionId: input.sessionId,
            role: input.role,
            turnId: input.turnId,
            parentActionId: input.turnId,
          },
        });
        yield* executor.recover();
        const pin = SessionTurn.Resume.parse(
          SessionHandleStore.actionById(input.actionId)?.intent.value,
        ).context;
        witness.capture = {
          context: pin,
          toolsGeneration: input.toolsGeneration,
          toolsHash: input.toolsHash,
          systemHash: input.systemHash,
          history: z.array(Message.WithParts).parse(input.history),
          messages: input.messages.map((message) => ({ ...message })),
          recoveryUnchanged:
            canonicalDigest(before) === canonicalDigest(sessionTree(reconstructionSession)),
        };
        boundary?.(witness);
        return { kind: "result" as const, text: "" };
      }),
      runtime,
    );
    return witness;
  }).pipe(Effect.ensuring(closeSessions(runtime).pipe(Effect.orDie))), runtime)));
}

/** Injectable witness/exit seam: the process cut is abrupt; the same main is tested in-process. */
export async function reconstructionProcessMain(
  args: string[],
  emit: (value: Witness | ReturnType<InstanceType<typeof FoldCheckpointIntegrityError>["toObject"]>) => void,
  exit: (code: number) => void,
) {
  const [stage, dbPath] = z
    .tuple([z.enum(["write", "read", "wake"]), z.string().min(1)])
    .parse(args);
  try {
    const witness = await reconstructionMain(stage, dbPath, (value) => {
      emit(value);
      exit(0);
    });
    if (stage !== "wake" || witness.capture === undefined) {
      emit(witness);
      exit(0);
    }
  } catch (error) {
    if (!(error instanceof FoldCheckpointIntegrityError)) throw error;
    emit(error.toObject());
    exit(1);
  }
}

if (import.meta.main) {
  const [witnessPath, ...rest] = process.argv.slice(2);
  await reconstructionProcessMain(
    rest,
    (value) => writeFileSync(z.string().min(1).parse(witnessPath), `${JSON.stringify(value)}\n`),
    (code) => process.exit(code),
  );
}
