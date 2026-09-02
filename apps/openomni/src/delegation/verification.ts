// allow: SIZE_OK — one exhaustive command-result-to-durable-facts state machine owns live and recovery folds.
import { createHash } from "node:crypto";
import { WorkItemStore } from "@openomni/ledger";
import { Delegation, Operational, type WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";
import type { Admitted } from "./admission";
import type { DriverOutcome } from "./kernel";
import { delegationTraceId } from "./trace";

export type CommandRunResult =
  | {
      readonly status: "exited";
      readonly exitCode: number;
      readonly stdoutSha256: string;
      readonly stderrSha256: string;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly truncated: boolean;
      readonly durationMs: number;
    }
  | { readonly status: "timed_out"; readonly durationMs: number }
  | { readonly status: "killed"; readonly signal: string; readonly durationMs: number }
  | {
      readonly status: "refused";
      readonly reason: "isolation_unavailable" | "executable_unregistered" | "machine_not_attached";
    };

export interface CommandVerifierPort {
  run(input: {
    readonly executableId: string;
    readonly argv: readonly string[];
    readonly timeoutMs: number;
    readonly tenant: string;
  }): Promise<CommandRunResult>;
}

export interface VerificationCoordinator {
  settleAssign(input: {
    readonly admitted: Admitted;
    readonly record: Delegation.Record;
    readonly outcome: Extract<DriverOutcome, { readonly status: "completed" }>;
    readonly at: number;
  }): Promise<Delegation.Settled>;
  recoverSettlement(record: Delegation.Record, at: number): Delegation.Settled | undefined;
}

const CommandRunResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("exited"),
      exitCode: z.number().int(),
      stdoutSha256: z.string().regex(/^[0-9a-f]{64}$/),
      stderrSha256: z.string().regex(/^[0-9a-f]{64}$/),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal("timed_out"), durationMs: z.number().nonnegative() }).strict(),
  z
    .object({
      status: z.literal("killed"),
      signal: z.string().min(1),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["isolation_unavailable", "executable_unregistered", "machine_not_attached"]),
    })
    .strict(),
]);

type RecordedFacts = Readonly<{
  results: readonly WorkItem.CriterionResult[];
  errors: readonly WorkItem.VerificationErrorFact[];
}>;

function settlementPrefix(
  record: Delegation.Record,
  output: string,
  at: number,
  outcome?: Extract<DriverOutcome, { readonly status: "completed" }>,
) {
  return {
    delegationId: record.delegationId,
    output,
    at,
    ...(outcome?.workerRunId === undefined ? {} : { workerRunId: outcome.workerRunId }),
    ...(outcome?.usage === undefined ? {} : { usage: outcome.usage }),
  };
}

function foldFacts(
  record: Delegation.Record,
  item: WorkItem.Info,
  facts: RecordedFacts,
  output: string,
  at: number,
  outcome?: Extract<DriverOutcome, { readonly status: "completed" }>,
): Delegation.Settled {
  const required = new Set(
    item.completionFacts.criteria
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.id),
  );
  const verified = facts.results.filter(
    (result) => result.value === "verified" && required.has(result.criterionId),
  );
  const prefix = settlementPrefix(record, output, at, outcome);
  if (required.size > 0 && verified.length === required.size && facts.errors.length === 0) {
    return Delegation.Settled.parse({
      ...prefix,
      status: "verified",
      basisRef: item.completionContract.basisRef,
      factIds: verified.map((result) => result.id),
    });
  }
  return Delegation.Settled.parse({
    ...prefix,
    status: "unverified",
    reason: facts.errors.length > 0 ? "verification_error" : "verification_failed",
    basisRef: item.completionContract.basisRef,
    factIds: [...facts.results, ...facts.errors].map((fact) => fact.id),
  });
}

function unverified(
  record: Delegation.Record,
  outcome: Extract<DriverOutcome, { readonly status: "completed" }>,
  at: number,
  reason: Delegation.UnverifiedReason,
): Delegation.Settled {
  return Delegation.Settled.parse({
    ...settlementPrefix(record, outcome.output, at, outcome),
    status: "unverified",
    reason,
    factIds: [],
  });
}

function publishWriterRefusal(record: Delegation.Record, reason: string, at: number): void {
  Bus.publish(Operational.Events.Error, {
    traceId: delegationTraceId(record.delegationId),
    sessionId: record.origin.sessionId,
    time: at,
    component: "delegation",
    msg: `Verification fact write refused for ${record.delegationId}`,
    error: reason,
    context: { delegationId: record.delegationId, workItemId: record.workItemId ?? "" },
  });
}

export function createVerificationCoordinator(ports: {
  readonly verifier?: CommandVerifierPort;
  readonly now: () => number;
}): VerificationCoordinator {
  async function settleAssign(input: {
    readonly admitted: Admitted;
    readonly record: Delegation.Record;
    readonly outcome: Extract<DriverOutcome, { readonly status: "completed" }>;
    readonly at: number;
  }): Promise<Delegation.Settled> {
    const { admitted, record, outcome, at } = input;
    const declaration = admitted.request.verification;
    if (declaration === undefined) return unverified(record, outcome, at, "not_declared");
    if (ports.verifier === undefined) {
      return unverified(record, outcome, at, "verifier_unavailable");
    }
    if (record.workItemId === undefined)
      return unverified(record, outcome, at, "verification_error");
    const item = WorkItemStore.get(record.workItemId);
    if (item === undefined) {
      publishWriterRefusal(record, "unknown_item", at);
      return unverified(record, outcome, at, "verification_error");
    }
    if (item.attemptTerminal !== undefined)
      return unverified(record, outcome, at, "scope_superseded");
    const requiredIndexes = item.completionFacts.criteria
      .map((criterion, index) => (criterion.required ? index : undefined))
      .filter((index) => index !== undefined);
    const declaredIndexes = new Set(declaration.expectations.map((entry) => entry.criterionIndex));
    if (requiredIndexes.some((index) => !declaredIndexes.has(index))) {
      return unverified(record, outcome, at, "not_declared");
    }
    const attemptId = item.currentAttemptId;
    if (attemptId === undefined) return unverified(record, outcome, at, "scope_superseded");
    const attemptRef = `attempt:${attemptId}`;
    const verifierRef = `verifier:command.v1:${record.delegationId}:${attemptRef}`;
    let run: z.infer<typeof CommandRunResultSchema> | undefined;
    try {
      const candidate = await ports.verifier.run({
        executableId: declaration.executable.id,
        argv: declaration.argv,
        timeoutMs: declaration.timeoutMs,
        tenant: record.origin.sessionId,
      });
      const parsed = CommandRunResultSchema.safeParse(candidate);
      if (parsed.success) run = parsed.data;
    } catch (error) {
      if (error instanceof Error) void error.message;
    }
    const observations: WorkItem.Observation[] = [];
    const results: WorkItem.CriterionResult[] = [];
    const errors: WorkItem.VerificationErrorFact[] = [];
    const evidence: Array<
      Omit<WorkItem.Evidence, "attempt" | "basisRef" | "createdAt"> & { id: string }
    > = [
      {
        id: `evidence:delegation:${record.delegationId}:${attemptRef}:worker-report`,
        kind: "custom",
        description: "worker-reported completion, unverified",
        passed: false,
        detail: outcome.output.slice(0, 2_048),
      },
    ];
    const argvHash = createHash("sha256").update(JSON.stringify(declaration.argv)).digest("hex");
    for (const expectation of declaration.expectations) {
      const criterion = item.completionFacts.criteria[expectation.criterionIndex];
      if (criterion === undefined) continue;
      const suffix = `${record.delegationId}:${attemptRef}:${criterion.id}`;
      const errorId = `error:verifier:${suffix}`;
      if (run === undefined || run.status === "refused") {
        errors.push({
          id: errorId,
          criterionId: criterion.id,
          code: run === undefined ? "verifier_crash" : "prohibited_capability",
          detail: run === undefined ? "command verifier crashed" : run.reason,
          verifierRef,
          basisRef: item.completionContract.basisRef,
          createdAt: at,
        });
        continue;
      }
      const evidenceId = `evidence:verifier:${suffix}`;
      const observationId = `observation:verifier:${suffix}`;
      const resultId = `result:verifier:${suffix}`;
      const matches =
        run.status === "exited" &&
        run.exitCode === expectation.exitCode &&
        (expectation.stdoutSha256 === undefined || expectation.stdoutSha256 === run.stdoutSha256) &&
        (expectation.stderrSha256 === undefined || expectation.stderrSha256 === run.stderrSha256);
      const value = run.status === "exited" ? (matches ? "verified" : "refuted") : "inconclusive";
      const actual = run.status === "exited" ? String(run.exitCode) : run.status;
      evidence.push({
        id: evidenceId,
        kind: "verification",
        criterionId: criterion.id,
        description: `command.v1 ${declaration.executable.id}: exit ${actual} (expected ${expectation.exitCode})`,
        passed: matches,
        detail: JSON.stringify(run),
      });
      observations.push({
        id: observationId,
        producer: "verifier:command.v1",
        subjectRef: item.workItemId,
        basisRef: item.completionContract.basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [attemptRef],
        observedAt: at,
      });
      results.push({
        id: resultId,
        criterionId: criterion.id,
        value,
        checkedPredicate: `command.v1:${declaration.executable.id}:${argvHash}:exit=${expectation.exitCode}${expectation.stdoutSha256 === undefined ? "" : `:stdout=${expectation.stdoutSha256}`}${expectation.stderrSha256 === undefined ? "" : `:stderr=${expectation.stderrSha256}`}`,
        observationIds: [observationId],
        verifierRef,
        assumptions: [],
        basisRef: item.completionContract.basisRef,
        residualRisks: [],
        createdAt: at,
      });
    }
    const write = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      {
        expectedAttempt: item.lastAttemptSeq,
        expectedAttemptId: attemptId,
        expectedBasisRef: item.completionContract.basisRef,
        observations,
        results,
        verificationErrors: errors,
        evidence,
        verifierRef,
      },
      delegationTraceId(record.delegationId),
    );
    if (write.kind === "refused") {
      if (
        write.reason === "stale_attempt" ||
        write.reason === "stale_basis" ||
        write.reason === "attempt_closed"
      ) {
        return unverified(record, outcome, at, "scope_superseded");
      }
      publishWriterRefusal(record, write.reason, at);
      return unverified(record, outcome, at, "verification_error");
    }
    return foldFacts(
      record,
      WorkItemStore.get(item.workItemId) ?? item,
      { results, errors },
      outcome.output,
      at,
      outcome,
    );
  }

  function recoverSettlement(
    record: Delegation.Record,
    at: number,
  ): Delegation.Settled | undefined {
    if (record.operation !== "assign" || record.workItemId === undefined) return undefined;
    const item = WorkItemStore.get(record.workItemId);
    if (item === undefined || item.currentAttemptId === undefined) return undefined;
    const attemptRef = `attempt:${item.currentAttemptId}`;
    const verifierRef = `verifier:command.v1:${record.delegationId}:${attemptRef}`;
    const basisRef = item.completionContract.basisRef;
    const evidenceIds = new Set(
      item.evidence
        .filter((fact) => fact.attempt === item.lastAttemptSeq && fact.basisRef === basisRef)
        .map((fact) => fact.id),
    );
    const observationIds = new Set(
      item.completionFacts.observations
        .filter(
          (fact) =>
            fact.basisRef === basisRef &&
            fact.ancestryRefs.includes(attemptRef) &&
            fact.artifactRefs.some((artifactRef) => evidenceIds.has(artifactRef)),
        )
        .map((fact) => fact.id),
    );
    const results = item.completionFacts.results.filter(
      (fact) =>
        fact.verifierRef === verifierRef &&
        fact.basisRef === basisRef &&
        fact.observationIds.every((observationId) => observationIds.has(observationId)),
    );
    const errors = item.completionFacts.verificationErrors.filter(
      (fact) => fact.verifierRef === verifierRef && fact.basisRef === basisRef,
    );
    if (results.length === 0 && errors.length === 0) return undefined;
    const report = item.evidence.find(
      (fact) =>
        fact.id === `evidence:delegation:${record.delegationId}:${attemptRef}:worker-report` &&
        fact.attempt === item.lastAttemptSeq &&
        fact.basisRef === basisRef,
    );
    return foldFacts(record, item, { results, errors }, report?.detail ?? "", at);
  }

  return { settleAssign, recoverSettlement };
}
