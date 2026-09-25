import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { Llm } from "@openomni/llm";
import type {
  AnyToolDefinition,
  ObservationSink as ObservationPort,
  SessionGeneration,
} from "@openomni/protocol";
import { Context, type Effect, type Scope } from "effect";
import type { SessionError } from "./errors";
import type { NamedPolicyRegistry } from "./bundle";
import type { GenerationRawSlots } from "./session-generations";
import type { ToolDispatchDefinition } from "./tool-dispatcher";

export type ProcessServices = Clock | Entropy | ObservationSink;
export type GenerationServices = SessionLayer | ToolCatalog | ObservationSink | NamedPolicyRegistry;
export type SessionEntryServices = ProcessServices | Llm | GenerationLayers;
export type RunnerServices = ProcessServices | SessionLayer | ToolCatalog | Llm | GenerationOwnership;

export interface CapturedGeneration {
  readonly id: SessionGeneration.Id;
  readonly snapshot: SessionGeneration.Snapshot;
  provide<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, GenerationServices | GenerationRawSlots | GenerationOwnership>>;
  retain(): () => void;
}

export class GenerationOwnership extends Context.Tag("@openomni/agent/GenerationOwnership")<GenerationOwnership, CapturedGeneration>() {}

export interface GenerationLayersService {
  initialize(definitions: Readonly<Record<import("@openomni/protocol").LedgerSession.Role, readonly AnyToolDefinition[]>>): Effect.Effect<void, SessionError>;
  capture(id: SessionGeneration.Id): Effect.Effect<CapturedGeneration, SessionError, Scope.Scope>;
  configure<A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>): Effect.Effect<A, SessionError>;
  readonly drain: Effect.Effect<void, SessionError>;
}

export class GenerationLayers extends Context.Tag("@openomni/agent/GenerationLayers")<GenerationLayers, GenerationLayersService>() {}

export class Clock extends Context.Tag("@openomni/agent/Clock")<
  Clock,
  { readonly now: () => number }
>() {}

export class Entropy extends Context.Tag("@openomni/agent/Entropy")<
  Entropy,
  { readonly next: () => string }
>() {}

export class ObservationSink extends Context.Tag("@openomni/agent/ObservationSink")<
  ObservationSink,
  ObservationPort & Required<Pick<ObservationPort, "subscribe" | "scope">>
>() {}

export class SessionLayer extends Context.Tag("@openomni/agent/SessionLayer")<
  SessionLayer,
  { readonly snapshot: SessionGeneration.Snapshot; readonly policy: CompiledPolicySnapshot }
>() {}

export class ToolCatalog extends Context.Tag("@openomni/agent/ToolCatalog")<
  ToolCatalog,
  { readonly definitions: readonly ToolDispatchDefinition[] }
>() {}
