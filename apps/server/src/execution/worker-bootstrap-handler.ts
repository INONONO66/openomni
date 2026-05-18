import { AgentRegistry } from "@openomni/agent";
import type { Auth } from "@openomni/llm";
import { Operational, WorkerBootstrap } from "@openomni/protocol";
import { Bus } from "@openomni/session";

export namespace WorkerBootstrapHandler {
  export interface ServerPort {
    useConnection(id: string): void;
    notify(method: string, params?: Record<string, unknown>): void;
  }

  export interface State {
    readonly ready: Promise<void>;
    getBootstrap(): WorkerBootstrap.Bootstrap | null;
    resolveAuth(provider: string): Auth.Info | undefined;
  }

  export interface CreateStateOptions {
    readonly onBootstrap?: (bootstrap: WorkerBootstrap.Bootstrap) => void;
  }

  export interface HandleOptions {
    readonly params: Record<string, unknown> | undefined;
    readonly ipcAuthToken: string;
    readonly workerId: string;
    readonly server: ServerPort;
    readonly connectionId: string;
    readonly respond: (result: unknown) => void;
    readonly state: MutableState;
  }

  export interface MutableState extends State {
    setBootstrap(bootstrap: WorkerBootstrap.Bootstrap): void;
    markReady(): void;
    rejectReady(error: Error): void;
  }

  export function createState(options: CreateStateOptions = {}): MutableState {
    let bootstrap: WorkerBootstrap.Bootstrap | null = null;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (_error: Error) => void = () => undefined;

    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    return {
      ready,
      getBootstrap: () => bootstrap,
      resolveAuth: (provider) => resolveBootstrapAuth(bootstrap, provider),
      setBootstrap(nextBootstrap) {
        bootstrap = nextBootstrap;
        options.onBootstrap?.(nextBootstrap);
      },
      markReady() {
        resolveReady();
      },
      rejectReady,
    } satisfies MutableState;
  }

  export function handleBootstrap(options: HandleOptions): void {
    if (options.params?.authToken !== options.ipcAuthToken) {
      options.respond({ ok: false, error: "unauthorized" });
      return;
    }

    try {
      const bootstrap = WorkerBootstrap.Bootstrap.parse(options.params.bootstrap);
      options.state.setBootstrap(bootstrap);
      AgentRegistry.replaceAll(
        bootstrap.agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools.allow ?? [],
          permissions: agent.permissions,
          policyPlan: agent.policyPlan,
          budget: agent.budget,
        })),
      );
      options.server.useConnection(options.connectionId);
      options.state.markReady();
      options.server.notify("worker.bootstrap_ready", {
        workerId: options.workerId,
        authToken: options.ipcAuthToken,
      });
      Bus.publish(Operational.Info, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "worker bootstrap received",
        context: {
          workerId: options.workerId,
          agents: bootstrap.agents.length,
          mcpTools: bootstrap.toolCatalog.length,
        },
      });
      options.respond({ ok: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.state.rejectReady(error);
      options.respond({ ok: false, error: error.message });
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "worker bootstrap failed",
        context: {
          workerId: options.workerId,
          err: error.message,
        },
      });
    }
  }

  function resolveBootstrapAuth(
    bootstrap: WorkerBootstrap.Bootstrap | null,
    provider: string,
  ): Auth.Info | undefined {
    const credentials = bootstrap?.credentials;
    if (!credentials) return undefined;

    const prefix = provider.toUpperCase();
    const apiKey = credentials[`${prefix}_API_KEY`];
    const baseURL = credentials[`${prefix}_BASE_URL`];

    if (baseURL) {
      return { type: "proxy", baseURL, ...(apiKey ? { apiKey } : {}) };
    }
    if (apiKey) {
      return { type: "api", key: apiKey };
    }
    return undefined;
  }
}
