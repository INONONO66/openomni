import type { CompiledPolicySnapshot } from "@openomni/policy";
import type {
  AnyToolDefinition,
  ObservationSink as ObservationPort,
  SessionGeneration,
} from "@openomni/protocol";
import { Context } from "effect";

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
  ObservationPort
>() {}

export class SessionLayer extends Context.Tag("@openomni/agent/SessionLayer")<
  SessionLayer,
  { readonly snapshot: SessionGeneration.Snapshot; readonly policy: CompiledPolicySnapshot }
>() {}

export class ToolCatalog extends Context.Tag("@openomni/agent/ToolCatalog")<
  ToolCatalog,
  { readonly definitions: readonly AnyToolDefinition[] }
>() {}
