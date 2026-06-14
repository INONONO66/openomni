type Axis =
  | "blacklist"
  | "channel_grant"
  | "personal_or_channel_default_grant"
  | "session_ownership_grant"
  | "pending_interaction_scope";

type Verdict = "allow" | "deny" | "not_required";

interface AxisDecision {
  readonly axis: Axis;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly evidence?: readonly string[];
}

export namespace EffectiveAuthority {
  export interface Result {
    readonly allowed: boolean;
    readonly reason: string;
    readonly axes: readonly AxisDecision[];
    readonly factsUsed: readonly string[];
  }

  function axis(
    axisName: Axis,
    verdict: Verdict,
    reason: string,
    evidence: readonly string[] = [],
  ): AxisDecision {
    return { axis: axisName, verdict, reason, evidence };
  }

  function evaluate(axes: readonly AxisDecision[], allowReason: string): Result {
    const denied = axes.find((entry) => entry.verdict === "deny");
    const factsUsed = axes.flatMap((entry) => [
      `effective_authority.${entry.axis}.${entry.verdict}`,
      ...(entry.evidence ?? []),
    ]);

    return {
      allowed: denied === undefined,
      reason: denied?.reason ?? allowReason,
      axes,
      factsUsed,
    };
  }

  export function blockedByBlacklist(reason: string, kind: string): Result {
    return evaluate(
      [
        axis("blacklist", "deny", reason, [`blacklist.${kind}`]),
        axis("channel_grant", "not_required", "dispatch.channel_grant.not_required"),
        axis(
          "personal_or_channel_default_grant",
          "not_required",
          "dispatch.actor.grant.not_evaluated_after_blacklist",
        ),
        axis(
          "session_ownership_grant",
          "not_required",
          "dispatch.session_ownership.not_evaluated_after_blacklist",
        ),
        axis(
          "pending_interaction_scope",
          "not_required",
          "dispatch.pending_interaction.not_evaluated_after_blacklist",
        ),
      ],
      "dispatch.default.allowed",
    );
  }

  export function missingActor(): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis("personal_or_channel_default_grant", "deny", "dispatch.actor.required"),
        axis("session_ownership_grant", "not_required", "dispatch.session_ownership.not_required"),
        axis(
          "pending_interaction_scope",
          "not_required",
          "dispatch.pending_interaction.not_required",
        ),
      ],
      "dispatch.default.allowed",
    );
  }

  export function nonWorker(reason: string): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis("personal_or_channel_default_grant", "allow", "dispatch.actor.personal_grant.allowed"),
        axis("session_ownership_grant", "not_required", "dispatch.session_ownership.not_required"),
        axis(
          "pending_interaction_scope",
          "not_required",
          "dispatch.pending_interaction.not_required",
        ),
      ],
      reason,
    );
  }

  export function workerGrant(granted: DispatchWorkerGrantResult, denyReason: string): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis("personal_or_channel_default_grant", "allow", "dispatch.actor.worker_grant_candidate"),
        axis(
          "session_ownership_grant",
          granted.allowed ? "allow" : "deny",
          granted.allowed ? granted.reason : denyReason,
          [granted.reason],
        ),
        axis(
          "pending_interaction_scope",
          "not_required",
          "dispatch.pending_interaction.not_required",
        ),
      ],
      granted.reason,
    );
  }

  export function workerNotRequired(reason: string): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis(
          "personal_or_channel_default_grant",
          "allow",
          "dispatch.actor.worker_resident_ask.allowed",
        ),
        axis("session_ownership_grant", "not_required", "dispatch.session_ownership.not_required"),
        axis(
          "pending_interaction_scope",
          "not_required",
          "dispatch.pending_interaction.not_required",
        ),
      ],
      reason,
    );
  }

  export function workerDenied(reason: string): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis("personal_or_channel_default_grant", "allow", "dispatch.actor.worker_grant_candidate"),
        axis("session_ownership_grant", "deny", reason),
        axis(
          "pending_interaction_scope",
          "not_required",
          "dispatch.pending_interaction.not_required",
        ),
      ],
      reason,
    );
  }

  export function pendingInteraction(reason: string, interactionId: string): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis("personal_or_channel_default_grant", "allow", "dispatch.actor.assigned_worker"),
        axis("session_ownership_grant", "not_required", "dispatch.session_ownership.not_required"),
        axis("pending_interaction_scope", "allow", reason, [
          `pending_interaction.${interactionId}`,
        ]),
      ],
      reason,
    );
  }

  export function pendingInteractionDenied(reason: string): Result {
    return evaluate(
      [
        ...baselineAxes(),
        axis("personal_or_channel_default_grant", "allow", "dispatch.actor.grant_candidate"),
        axis("session_ownership_grant", "not_required", "dispatch.session_ownership.not_required"),
        axis("pending_interaction_scope", "deny", reason),
      ],
      reason,
    );
  }

  function baselineAxes(): AxisDecision[] {
    return [
      axis("blacklist", "allow", "dispatch.blacklist.clear"),
      axis("channel_grant", "not_required", "dispatch.channel_grant.not_required"),
    ];
  }

  type DispatchWorkerGrantResult = {
    readonly allowed: boolean;
    readonly reason: string;
  };
}
