import { Database } from "bun:sqlite";
import { Bus } from "@openomni/agent";
import { PersonStore, SessionHandleStore, Storage } from "@openomni/ledger";
import { L0Observation, type PlainValue, type Tool } from "@openomni/protocol";
import { z } from "zod";
import { startOpenOmni } from "../../src/index";
import { assistantMessage, requestToolStep } from "./assistant-message";

export const OWNER_TOKEN = "request-owner-e2e-token";
export const PERSON = {
  id: "person:request-owner-e2e",
  displayName: "Original protected manifest",
  kind: "human",
  trustTier: "manager",
  endpoints: [{ channel: "ws", externalId: "protected-person" }],
} as const;
export const ORIGINAL_CALL = {
  id: "original-person-declare",
  tool: "provision",
  input: {
    operation: {
      op: "person_declare",
      args: { manifest: { ...PERSON, endpoints: [...PERSON.endpoints] } },
    },
  },
} satisfies Tool.Call;

function snapshot(dbPath: string, modelCalls: number) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      pid: process.pid,
      modelCalls,
      person: PersonStore.get(PERSON.id) ?? null,
      requests: SessionHandleStore.requestRows(),
      sessions: SessionHandleStore.listRows().map((row) => ({
        row,
        actions: SessionHandleStore.tree(row.id),
        generation: SessionHandleStore.latestGeneration(SessionHandleStore.tree(row.id)),
        inbox: SessionHandleStore.inboxRows(row.id),
      })),
      tables: z
        .array(z.object({ name: z.string() }))
        .parse(db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all())
        .map((row) => row.name),
      adapterKeys: Object.keys(Storage.get()),
    };
  } finally {
    db.close();
  }
}

export type OwnerSnapshot = ReturnType<typeof snapshot>;
export type OwnerProcessEvent =
  | { type: "ready"; port: number; snapshot: OwnerSnapshot }
  | { type: "opened"; snapshot: OwnerSnapshot }
  | { type: "suspended"; snapshot: OwnerSnapshot }
  | { type: "model"; snapshot: OwnerSnapshot }
  | { type: "applied"; snapshot: OwnerSnapshot }
  | { type: "settled"; snapshot: OwnerSnapshot }
  | { type: "snapshot"; id: string; snapshot: OwnerSnapshot }
  | { type: "error"; error: string };

const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), id: z.string() }),
  z.object({ type: z.literal("drift"), id: z.string() }),
  z.object({ type: z.literal("stop") }),
]);

async function serve() {
  const dbPath = z.string().min(1).parse(process.argv[2]);
  const at = z.coerce.number().int().positive().parse(process.argv[3]);
  const recovering = process.argv[4] === "recover";
  let modelCalls = 0;
  let app: Awaited<ReturnType<typeof startOpenOmni>> | undefined;
  const emit = (event: OwnerProcessEvent) => process.send?.(event);
  const state = () => snapshot(dbPath, modelCalls);
  const failure = (error: Error | string) =>
    emit({
      type: "error",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  let opened = false;
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const action = SessionHandleStore.tree(event.sessionId).find((item) => item.id === event.id);
    const request = SessionHandleStore.requestRows(event.sessionId).find(
      (item) => item.callId === ORIGINAL_CALL.id && item.state === "open",
    );
    if (
      !opened &&
      request !== undefined &&
      action?.id === `${request.requestId}:input:${request.requestId}:open`
    ) {
      opened = true;
      emit({ type: "opened", snapshot: state() });
    }
    const effect = action?.effect.value;
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return;
    if (
      action?.kind === "tool" &&
      effect.phase === "result" &&
      effect.callId === ORIGINAL_CALL.id
    ) {
      emit({ type: "applied", snapshot: state() });
    }
    if (action?.kind === "turn" && effect.phase === "terminal") {
      emit({ type: "settled", snapshot: state() });
    }
  });
  process.on("message", (message: PlainValue) => {
    const command = Command.parse(message);
    if (command.type === "stop") {
      void (async () => {
        unsubscribe();
        await app?.stop();
        Storage.reset();
        process.disconnect?.();
      })().catch(failure);
      return;
    }
    if (command.type === "drift") {
      PersonStore.put({
        ...PERSON,
        endpoints: [...PERSON.endpoints],
        trustTier: "observer",
        displayName: "Concurrent domain revision",
        revision: 0,
        createdBy: "fixture",
        updatedAt: at,
      });
    }
    emit({ type: "snapshot", id: command.id, snapshot: state() });
  });
  // No replacement definitions, mocked dispatcher, or regenerated captured generation:
  // every process builds the same real catalog through the production app root.
  app = await startOpenOmni({
    config: {
      dbPath,
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: OWNER_TOKEN,
      actors: [{ actorId: "owner", externalId: "owner", kind: "human", trustTier: "owner" }],
      model: { provider: "fake", id: "request-owner-e2e", apiKey: "fixture-key" },
    },
    sessionRuntime: {
      clock: () => at,
      scheduleApprovalTimeout: () => {
        emit({ type: "suspended", snapshot: state() });
        return () => undefined;
      },
    },
    llm: {
      resolveModel: async (model) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: async (input, sink) => {
        modelCalls += 1;
        emit({ type: "model", snapshot: state() });
        if (recovering) {
          const person = PersonStore.get(PERSON.id);
          if (person?.trustTier !== "manager" || person.revision !== 0) {
            throw new Error("LLM entered before original protected Person mutation");
          }
          sink.onMessage(assistantMessage(input, { text: "Recovered original invocation." }));
          return { type: "stop" };
        }
        const result = requestToolStep(input, sink, ORIGINAL_CALL);
        if (result !== undefined)
          throw new Error(`unexpected pre-crash tool result: ${result.output}`);
        return { type: "stop" };
      },
    },
  });
  emit({ type: "ready", port: app.port, snapshot: state() });
}

if (import.meta.main) {
  void serve().catch((error: Error | string) => {
    process.send?.({
      type: "error",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    } satisfies OwnerProcessEvent);
    process.exitCode = 1;
  });
}
