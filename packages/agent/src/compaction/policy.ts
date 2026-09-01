import { Operational, Policy, PolicyDecision, type BusEvent } from "@openomni/protocol";
import { Compaction, DEFAULT_PROTECT_RECENT, type CompactionOptions } from "./compact";
import { DEFAULT_PREPARE_RATIO, createSpeculator, type Speculator } from "./speculate";
import type { PolicyRegistrationFactory } from "../core/policy/types";

type CompactionConfig = CompactionOptions & {
  /** Where the compaction record goes. The policy reports; it does not decide. */
  readonly events: BusEvent.Sink;
  /** Ordering relative to the product's other run.completion.pre policies — the caller's opinion, not the mechanism's. */
  readonly priority: number;
};

/**
 * Factory form since L4: the speculator is per-run state (a candidate must
 * die with its run — the #692 lesson), and factories are the one sanctioned
 * home for stateful policies (engines are built once per run and invoke
 * `create()` at registration).
 */
type CompactionPolicyRegistration = ReturnType<PolicyRegistrationFactory["create"]> & {
  readonly onRunEnd?: () => void;
  readonly speculationStarted?: () => Promise<void>;
  readonly speculationSettled?: () => Promise<void>;
};

type CompactionPolicyFactory = PolicyRegistrationFactory & {
  readonly create: () => CompactionPolicyRegistration;
};

type CompactionDispatchContext = Parameters<CompactionPolicyRegistration["fn"]>[0];

export function createCompactionPolicy(config: CompactionConfig): CompactionPolicyFactory {
  return {
    kind: "factory",
    name: "builtin:compaction",
    create: () => buildRegistration(config),
  };
}

function allow(reasonCodes?: string[]): Policy.PolicyDecision {
  return PolicyDecision.allow({
    policyId: "builtin.compaction",
    ...(reasonCodes === undefined ? {} : { reasonCodes }),
  });
}

function prepareSpeculation(
  ctx: CompactionDispatchContext,
  speculator: Speculator | undefined,
  events: BusEvent.Sink,
  contextWindowTokens: number,
): Policy.PolicyDecision {
  if (ctx.contextTokens === undefined) return allow();
  speculator?.maybePrepare(
    ctx.messages ?? [],
    ctx.contextTokens,
    contextWindowTokens,
    (error, failStreak) => {
      events.publish(Operational.Events.Warn, {
        traceId: ctx.traceContext?.traceId ?? "",
        time: Date.now(),
        ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
        component: "compaction-speculate",
        msg:
          failStreak >= 2
            ? "prepare failed; speculation disabled for this run"
            : "prepare failed; will retry next turn",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    },
  );
  return allow();
}

function resolveCompactionIdentity(
  ctx: CompactionDispatchContext,
):
  | { readonly identity: Parameters<typeof Compaction.compact>[2] }
  | { readonly decision: Policy.PolicyDecision } {
  const traceId = ctx.traceContext?.traceId;
  if (traceId === undefined || traceId.length === 0) {
    return { decision: allow(["compaction_skipped_no_trace"]) };
  }
  const sessionId = ctx.sessionId;
  if (sessionId === undefined || sessionId.length === 0) {
    return { decision: allow(["compaction_skipped_no_session"]) };
  }
  const runId = ctx.traceContext?.runId;
  return {
    identity: {
      traceId,
      sessionId,
      actorId: ctx.actorId,
      ...(runId === undefined ? {} : { runId }),
    },
  };
}

function compactionResultDecision(result: Awaited<ReturnType<typeof Compaction.compact>>) {
  const candidateReason =
    result.candidate === undefined ? [] : [`compaction_candidate_${result.candidate}`];
  const summarizerReason =
    result.summarizerFailed === true ? ["compaction_summarizer_failed"] : [];
  if (!result.compacted) {
    return allow([
      result.blocked === "no_user_boundary"
        ? "compaction_skipped_no_boundary"
        : "compaction_skipped_nothing_reclaimed",
      ...candidateReason,
      ...summarizerReason,
    ]);
  }

  return PolicyDecision.allow({
    policyId: "builtin.compaction",
    reasonCodes: ["compaction_threshold_exceeded", ...candidateReason, ...summarizerReason],
    effects: [
      Policy.PolicyEffect.parse({ type: "run.replace_messages", messages: result.messages }),
    ],
  });
}

async function evaluateCompaction(
  ctx: CompactionDispatchContext,
  compaction: CompactionOptions,
  speculator: Speculator | undefined,
  events: BusEvent.Sink,
): Promise<Policy.PolicyDecision> {
  if (!ctx.messages || ctx.messages.length === 0) return allow();
  if (ctx.contextTokens === undefined && !ctx.contextYielded) {
    return allow(["compaction_skipped_no_measurement"]);
  }

  const contextWindowTokens = compaction.contextWindowTokens ?? ctx.contextWindowTokens;
  if (contextWindowTokens === undefined) return allow(["compaction_skipped_no_window"]);
  if (ctx.pointId === "run.turn.post") {
    return prepareSpeculation(ctx, speculator, events, contextWindowTokens);
  }

  const resolved = { ...compaction, contextWindowTokens };
  if (
    !ctx.contextYielded &&
    (ctx.contextTokens === undefined || !Compaction.shouldCompact(ctx.contextTokens, resolved))
  ) {
    return allow();
  }

  const identity = resolveCompactionIdentity(ctx);
  if ("decision" in identity) return identity.decision;

  const candidate = speculator?.peek();
  const result = await Compaction.compact(
    ctx.messages,
    resolved,
    identity.identity,
    events,
    {
      trigger: ctx.contextYielded ? "yield" : "threshold",
      ...(ctx.contextTokens === undefined ? {} : { measuredTokens: ctx.contextTokens }),
      ...(candidate === undefined ? {} : { candidate }),
    },
  );
  if (result.candidate !== undefined) speculator?.consume();
  return compactionResultDecision(result);
}

function buildRegistration(
  config: CompactionConfig,
): CompactionPolicyRegistration {
  const { events, priority, ...compaction } = config;
  const speculator: Speculator | undefined =
    compaction.onSummarize !== undefined && compaction.speculate !== false
      ? createSpeculator({
          prepareRatio: compaction.speculate?.prepareRatio ?? DEFAULT_PREPARE_RATIO,
          protectRecentMessages: compaction.protectRecentMessages ?? DEFAULT_PROTECT_RECENT,
          onSummarize: compaction.onSummarize,
        })
      : undefined;
  const pointIds =
    speculator === undefined
      ? (["run.completion.pre"] as const)
      : (["run.turn.post", "run.completion.pre"] as const);

  return {
    name: "builtin:compaction",
    kind: "point",
    pointIds,
    effectCapabilities: {
      "run.completion.pre": ["run.replace_messages"],
      ...(speculator === undefined ? {} : { "run.turn.post": [] }),
    },
    priority,
    onRunEnd: () => speculator?.abort(),
    speculationStarted: () => speculator?.started() ?? Promise.resolve(),
    speculationSettled: () => speculator?.settled() ?? Promise.resolve(),
    fn: (ctx) => evaluateCompaction(ctx, compaction, speculator, events),
  };
}
