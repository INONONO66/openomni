import type { Dispatch, Model, Policy } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { z } from "zod";

const AcceptanceCriterion = z.string().trim().min(1);
const WORKER_SPAWN_TEXT_OR_PROMPT_MESSAGE = "worker.spawn requires text or prompt";

const WorkerSpawnPayload = z
  .object({
    text: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    constraints: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine((payload) => payload.text !== undefined || payload.prompt !== undefined, {
    message: WORKER_SPAWN_TEXT_OR_PROMPT_MESSAGE,
    path: ["text"],
  })
  .transform((payload) => ({
    prompt: payload.text ?? payload.prompt ?? "",
    acceptanceCriteria: payload.acceptanceCriteria,
    ...(payload.constraints ? { constraints: payload.constraints } : {}),
  }));

type WorkerSpawnPayloadInput = z.input<typeof WorkerSpawnPayload>;
export type ParsedWorkerSpawnPayload = z.infer<typeof WorkerSpawnPayload>;

function resolveSessionId(command: Dispatch.Command, model: Model.Ref): string {
  if (command.target.sessionId) return command.target.sessionId;
  const title = `Dispatch worker ${command.action}`;
  const modelInfo = { providerID: model.provider, modelID: model.id };
  const session = command.target.parentSessionId
    ? Session.createChild({
        traceId: command.traceId,
        parentSessionId: command.target.parentSessionId,
        title,
        model: modelInfo,
      })
    : Session.create({ traceId: command.traceId, title, model: modelInfo });
  return session.id;
}

function resolveWorkerAgentName(target: Dispatch.Target): string | undefined {
  return target.id ?? target.name;
}

function workerSpawnPayloadErrorMessage(error: z.ZodError<WorkerSpawnPayloadInput>): string {
  if (error.issues.some((issue) => issue.code === "unrecognized_keys")) {
    return "worker.spawn payload contains unsupported fields";
  }

  const fields = new Set(error.issues.flatMap((issue) => issue.path.map(String)));
  if (fields.has("acceptanceCriteria")) {
    return "worker.spawn requires at least one acceptance criterion";
  }
  if (fields.has("constraints")) {
    return "worker.spawn constraints must be non-empty strings";
  }
  if (fields.has("text") || fields.has("prompt")) {
    return WORKER_SPAWN_TEXT_OR_PROMPT_MESSAGE;
  }

  return "worker.spawn payload is invalid";
}

export function parseWorkerSpawnPayload(payload: unknown): ParsedWorkerSpawnPayload {
  const parsed = WorkerSpawnPayload.safeParse(payload);
  if (!parsed.success) {
    const payloadRecord = payload && typeof payload === "object" ? payload : undefined;
    if (!payloadRecord || !("acceptanceCriteria" in payloadRecord)) {
      throw new Error("worker.spawn requires at least one acceptance criterion");
    }
    throw new Error(workerSpawnPayloadErrorMessage(parsed.error));
  }

  return parsed.data;
}

export function buildWorkerSpawnRequest(
  command: Dispatch.Command,
  model: Model.Ref,
  payload: ParsedWorkerSpawnPayload,
  policyPlan?: Policy.PolicyPlan,
) {
  const sessionId = resolveSessionId(command, model);
  return {
    runId: crypto.randomUUID(),
    sessionId,
    mode: "direct" as const,
    prompt: payload.prompt,
    model,
    agentName: resolveWorkerAgentName(command.target),
    workspaceRoot: command.workspaceRoot,
    traceId: command.traceId,
    ...(policyPlan ? { policyPlan } : {}),
  };
}
