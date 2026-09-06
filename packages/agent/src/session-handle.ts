import { SessionHandleStore } from "@openomni/ledger";
import { createPolicyCompiler, type CompiledPolicySnapshot } from "@openomni/policy";
import { LedgerAction, type LedgerSession, type SessionGeneration } from "@openomni/protocol";
import type {
  SessionRuntime,
  SessionHandle,
  SessionCreateOptions,
  SessionRunner,
  RegistryEntry,
  SessionController,
  SessionControllerLifecycle,
  SessionSystem,
} from "./session-contract";
import { toolSnapshot } from "./session-record";
import { createController } from "./session-controller";
export { SessionCommitError } from "./session-contract";
export type {
  SessionCreateOptions,
  SessionRunnerInput,
  SessionRunnerResult,
  SessionRunner,
  SessionRuntime,
  SessionHandle,
} from "./session-contract";

const registries = new WeakMap<SessionRuntime, SessionRegistry>();

export function session(options: SessionCreateOptions, runtime: SessionRuntime): SessionHandle {
  let registry = registries.get(runtime);
  if (registry === undefined) {
    registry = new SessionRegistry(runtime);
    registries.set(runtime, registry);
  }
  return registry.declare(options);
}

export function getSessionHandle(id: string, runtime: SessionRuntime): SessionHandle | undefined {
  return registries.get(runtime)?.get(id);
}

export async function sweepSessions(
  resolveRunner: (row: LedgerSession.Row) => SessionRunner,
  runtime: SessionRuntime,
): Promise<void> {
  let registry = registries.get(runtime);
  if (registry === undefined) {
    registry = new SessionRegistry(runtime);
    registries.set(runtime, registry);
  }
  await registry.sweep(resolveRunner);
}

export async function closeSessions(runtime: SessionRuntime): Promise<void> {
  const registry = registries.get(runtime);
  if (registry === undefined) return;
  registries.delete(runtime);
  await registry.close();
}

class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly policies = createPolicyCompiler({
    kinds: LedgerAction.Kind.options,
    source: {
      append: () => false,
      rows: (generation) => SessionHandleStore.policyRows(generation),
    },
  });
  private swept = false;
  private closed = false;

  constructor(private readonly runtime: SessionRuntime) {}

  pinPolicy(generation: number): CompiledPolicySnapshot {
    return this.policies.pin(generation);
  }

  get(id: string): SessionHandle | undefined {
    return this.entries.get(id)?.controller.handle;
  }

  declare(options: SessionCreateOptions): SessionHandle {
    if (this.closed) throw new Error("session registry is closed");
    const entropy = this.runtime.entropy ?? (() => crypto.randomUUID());
    const id = options.id ?? entropy();
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.runner !== options.runner) {
        throw new Error(`session ${id} is already bound to a different runner`);
      }
      return existing.controller.handle;
    }
    const tools = (options.tools ?? []).map(toolSnapshot);
    const materialized = SessionHandleStore.materialize({
      id,
      parentId: options.parentId ?? null,
      role: options.role,
      tools,
      system: {
        preset: options.system?.preset ?? "",
        blocks: options.system?.blocks ?? [],
      },
      policyGeneration: options.policyGeneration ?? SessionHandleStore.currentPolicyGeneration(),
      actionId: entropy(),
      at: (this.runtime.clock ?? Date.now)(),
    });
    if (!materialized.created) {
      assertDeclaration(materialized.row, options, tools, options.system);
    }
    return this.install(id, options.runner).controller.handle;
  }

  async sweep(resolveRunner: (row: LedgerSession.Row) => SessionRunner): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    for (const row of SessionHandleStore.listRows()) {
      const hasOpenTurn = SessionHandleStore.openTurns(SessionHandleStore.tree(row.id)).length > 0;
      const hasInbox = SessionHandleStore.pendingInbox(row.id).length > 0;
      if (!hasOpenTurn && !hasInbox) continue;
      const entry = this.entries.get(row.id) ?? this.install(row.id, resolveRunner(row));
      await entry.controller.reconcile();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.controller.handle.close()));
  }

  private install(id: string, runner: SessionRunner): RegistryEntry {
    if (this.closed) throw new Error("session registry is closed");
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    let controller: SessionController | undefined;
    const lifecycle: SessionControllerLifecycle = {
      reactivate: () => this.install(id, runner).controller.handle,
      release: () => {
        const entry = this.entries.get(id);
        if (controller !== undefined && entry?.controller === controller) this.entries.delete(id);
      },
    };
    controller = createController(id, runner, this.runtime, lifecycle, (generation) =>
      this.pinPolicy(generation),
    );
    const entry = { runner, controller };
    this.entries.set(id, entry);
    return entry;
  }
}

function assertDeclaration(
  row: LedgerSession.Row,
  options: SessionCreateOptions,
  tools: readonly SessionGeneration.Tool[],
  system: Partial<SessionSystem> | undefined,
): void {
  if (row.role !== options.role || row.parentId !== (options.parentId ?? null)) {
    throw new Error(`session declaration conflicts with durable identity: ${row.id}`);
  }
  const snapshot = SessionHandleStore.latestGeneration(SessionHandleStore.tree(row.id));
  const expected = SessionHandleStore.generationSnapshot({
    generation: snapshot.generation,
    revertTo: snapshot.revertTo,
    tools,
    system: {
      preset: system?.preset ?? "",
      blocks: system?.blocks ?? [],
    },
    policyGeneration: options.policyGeneration ?? snapshot.policyGeneration,
  });
  if (snapshot.toolsHash !== expected.toolsHash || snapshot.systemHash !== expected.systemHash) {
    throw new Error(`session declaration conflicts with durable generation: ${row.id}`);
  }
}
