import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { Llm } from "@openomni/llm";
import type {
  AnyToolDefinition,
  ObservationSink as ObservationPort,
  SessionGeneration,
} from "@openomni/protocol";
import { Context, type Effect, type Scope } from "effect";
import { Entropy } from "./core/entropy";
import type { SessionError } from "./errors";
import type { NamedPolicyRegistry } from "./bundle";
import type { GenerationRawSlots } from "./session-generations";
import type { ToolDispatchDefinition } from "./tool-dispatcher";

export { Entropy, type EntropySource } from "./core/entropy";

export type ProcessServices = Entropy | ObservationSink;
export type GenerationServices = SessionLayer | ToolCatalog | ObservationSink | NamedPolicyRegistry;
export type SessionEntryServices = ProcessServices | Llm | GenerationLayers;
export type RunnerServices = ProcessServices | SessionLayer | ToolCatalog | Llm | GenerationOwnership;

export interface CapturedGeneration {
  readonly id: SessionGeneration.Id;
  readonly snapshot: SessionGeneration.Snapshot;
  provide<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, GenerationServices | GenerationRawSlots | GenerationOwnership>>;
  isSelected(): boolean;
  retain(): () => void;
}

export class GenerationOwnership extends Context.Service<GenerationOwnership, CapturedGeneration>()("@openomni/agent/GenerationOwnership") {}

export interface GenerationLayersService {
  initialize(definitions: Readonly<Record<import("@openomni/protocol").LedgerSession.Role, readonly AnyToolDefinition[]>>): Effect.Effect<void, SessionError>;
  capture(id: SessionGeneration.Id): Effect.Effect<CapturedGeneration, SessionError, Scope.Scope>;
  configure<A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>): Effect.Effect<A, SessionError>;
  /** Awaits live generation owners (detached turns unwinding) before the fail-fast `drain`. */
  readonly settle: Effect.Effect<void>;
  readonly drain: Effect.Effect<void, SessionError>;
}

export class GenerationLayers extends Context.Service<GenerationLayers, GenerationLayersService>()("@openomni/agent/GenerationLayers") {}

export class ObservationSink extends Context.Service<
  ObservationSink,
  ObservationPort & Required<Pick<ObservationPort, "subscribe" | "scope">>
>()("@openomni/agent/ObservationSink") {}

export class SessionLayer extends Context.Service<
  SessionLayer,
  { readonly snapshot: SessionGeneration.Snapshot; readonly policy: CompiledPolicySnapshot }
>()("@openomni/agent/SessionLayer") {}

export class ToolCatalog extends Context.Service<
  ToolCatalog,
  { readonly definitions: readonly ToolDispatchDefinition[] }
>()("@openomni/agent/ToolCatalog") {}
