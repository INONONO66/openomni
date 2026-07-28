import type { ModelCatalogService } from "@openomni/llm";
import type { Execution, Tool } from "@openomni/protocol";
import { createToolExecutor } from "@openomni/openomni";
import type { BoundWorkerKernelPortV1, NativeTool } from "@openomni/openomni";

type WorkerInputMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

type WorkerTranscriptQueryPort = {
  query(request: Parameters<BoundWorkerKernelPortV1["query"]>[0]): Promise<unknown>;
};

function parseAuthenticatedTranscript(input: unknown): WorkerInputMessage[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("authenticated worker transcript projection is invalid");
  }
  const projection = input as {
    readonly version?: unknown;
    readonly kind?: unknown;
    readonly messages?: unknown;
  };
  if (
    projection.version !== "kernel-query-result-v1" ||
    projection.kind !== "authenticated_transcript" ||
    !Array.isArray(projection.messages) ||
    Object.keys(input).some((key) => key !== "version" && key !== "kind" && key !== "messages")
  ) {
    throw new Error("authenticated worker transcript projection is invalid");
  }
  return projection.messages.map((message) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("authenticated worker transcript message is invalid");
    }
    const value = message as { readonly role?: unknown; readonly content?: unknown };
    if (
      (value.role !== "user" && value.role !== "assistant") ||
      typeof value.content !== "string" ||
      Object.keys(message).some((key) => key !== "role" && key !== "content")
    ) {
      throw new Error("authenticated worker transcript message is invalid");
    }
    return { role: value.role, content: value.content };
  });
}

function expandRequestedToolNames(tools: Tool.Spec[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    names.add(tool.name);
    names.add(tool.name.replace(/_/g, "."));
  }
  return names;
}

/** Process-local catalog pinned to the authenticated runtime; it has no fetch or cache authority. */
export function createPinnedWorkerModelCatalog(options: {
  readonly model: Execution.Request["model"];
  readonly environment: Execution.LLMEnvironmentV1;
}): ModelCatalogService {
  const model = Object.freeze({
    id: options.model.id,
    name: options.model.id,
    provider: Object.freeze({ npm: options.environment.sdkPackage }),
  });
  const provider = Object.freeze({
    id: options.model.provider,
    name: options.model.provider,
    env: [] as string[],
    npm: options.environment.sdkPackage,
    models: Object.freeze({ [options.model.id]: model }),
  });
  Object.freeze(provider.env);
  const catalog = Object.freeze({ [options.model.provider]: provider });
  const loaded = Object.freeze({
    catalog,
    environment: options.environment,
    fallbackDiagnostics: Object.freeze([]),
  });
  return Object.freeze({
    async load() {
      return loaded;
    },
    async get() {
      return catalog;
    },
  }) as ModelCatalogService;
}

export async function buildWorkerInputMessages(
  kernel: WorkerTranscriptQueryPort,
  sessionId: string,
  prompt: string,
): Promise<WorkerInputMessage[]> {
  const transcript = parseAuthenticatedTranscript(
    await kernel.query({
      version: "kernel-query-v1",
      kind: "authenticated_transcript",
      sessionId,
    }),
  );
  const latest = transcript.at(-1);
  return latest?.role === "user" && latest.content === prompt
    ? transcript
    : [...transcript, { role: "user", content: prompt }];
}

export function selectRequestedTools(
  availableTools: NativeTool[],
  requestedTools: Execution.Request["tools"],
): NativeTool[] {
  const requestedNames = expandRequestedToolNames(requestedTools);
  if (requestedNames.size === 0) {
    return [];
  }

  return availableTools.filter((tool) => requestedNames.has(tool.spec.name));
}

export function createExecutionToolContext(
  request: Pick<Execution.Request, "tools" | "permissions" | "toolConfig"> & {
    sessionId?: string;
    runId?: string;
    agentName?: string;
  },
  availableTools: NativeTool[],
): {
  tools?: Execution.Request["tools"];
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
} {
  if ((request.tools?.length ?? 0) === 0) {
    return {};
  }

  const selectedTools = selectRequestedTools(availableTools, request.tools);
  if (selectedTools.length === 0) {
    return {};
  }
  return {
    tools: selectedTools.map((tool) => ({
      ...tool.spec,
      name: tool.spec.name.replace(/\./g, "_"),
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    })),
    toolExecutor: createToolExecutor({
      tools: selectedTools,
      config: {
        workspaceRoot: request.toolConfig?.workspaceRoot,
        runtime:
          request.sessionId && request.runId
            ? {
                sessionId: request.sessionId,
                runId: request.runId,
                agentName: request.agentName,
                workspaceRoot: request.toolConfig?.workspaceRoot,
              }
            : undefined,
      },
    }),
  };
}
