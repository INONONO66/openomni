import type { Storage } from "@openomni/ledger";
import { WorkItemStore } from "@openomni/ledger";
import { newTraceId, WorkItem } from "@openomni/protocol";

/**
 * Resident-side completion admission (kernel-contract completion law): a
 * WorkItem completes only through an admitted judgment over its acceptance
 * criteria. Worker reports are Evidence; only VERIFIED criterion results
 * admit. Anything less — asserted, refuted, missing — records a durable
 * block admission and refuses.
 */
export type CompletionJudgment =
  | Readonly<{ criterionId: string; value: "asserted" }>
  | Readonly<{
      criterionId: string;
      value: "verified" | "refuted";
      /** What was actually checked — the predicate the Resident exercised. */
      checkedPredicate: string;
      /** Evidence already on the WorkItem that the check consumed. */
      evidenceIds: readonly string[];
    }>;

type CompletionOutcome =
  | Readonly<{ admitted: true; workItemId: string }>
  | Readonly<{ admitted: false; reason: string }>;

interface WorkItemSummary {
  readonly workItemId: string;
  readonly name: string;
  readonly status: WorkItem.Status;
  readonly criteria: ReadonlyArray<Readonly<{ id: string; statement: string; required: boolean }>>;
  readonly evidence: ReadonlyArray<
    Readonly<{ id: string; kind: string; description: string; passed: boolean; detail?: string }>
  >;
  readonly attemptOutcome?: WorkItem.AttemptOutcome;
}

export interface CompletionPort {
  list(): WorkItemSummary[];
  inspect(workItemId: string): WorkItemSummary | undefined;
  complete(input: {
    workItemId: string;
    judgments: readonly CompletionJudgment[];
  }): Promise<CompletionOutcome>;
}

export interface CompletionPortOptions {
  readonly writer: Storage.WorkItemCompletionWriter;
  readonly now: () => number;
}

const POLICY_REF = "policy:resident-completion-v1";

function summarize(item: WorkItem.Info): WorkItemSummary {
  return {
    workItemId: item.workItemId,
    name: item.name,
    status: WorkItem.deriveStatus(item),
    criteria: item.completionFacts.criteria.map(({ id, statement, required }) => ({
      id,
      statement,
      required,
    })),
    evidence: item.evidence.map(({ id, kind, description, passed, detail }) => ({
      id,
      kind,
      description,
      passed,
      ...(detail === undefined ? {} : { detail }),
    })),
    ...(item.attemptTerminal === undefined ? {} : { attemptOutcome: item.attemptTerminal.outcome }),
  };
}

export function createCompletionPort(options: CompletionPortOptions): CompletionPort {
  function refuse(reason: string): CompletionOutcome {
    return { admitted: false, reason };
  }

  async function complete(input: {
    workItemId: string;
    judgments: readonly CompletionJudgment[];
  }): Promise<CompletionOutcome> {
    const current = WorkItemStore.get(input.workItemId);
    if (current === undefined) return refuse(`unknown WorkItem: ${input.workItemId}`);
    const status = WorkItem.deriveStatus(current);
    if (status === "completed" || status === "cancelled") {
      return refuse(`WorkItem ${input.workItemId} is already ${status}`);
    }
    if (status === "failed") {
      // A failed item outranks a completed timestamp in deriveStatus, so a
      // receipt written here could never surface as completed — retry first.
      return refuse(`WorkItem ${input.workItemId} is failed; retry the attempt before completing`);
    }
    const criteria = new Map(current.completionFacts.criteria.map((c) => [c.id, c]));
    const seen = new Set<string>();
    for (const judgment of input.judgments) {
      if (!criteria.has(judgment.criterionId)) {
        return refuse(`judgment targets an unknown criterion: ${judgment.criterionId}`);
      }
      if (seen.has(judgment.criterionId)) {
        return refuse(`duplicate judgment for criterion: ${judgment.criterionId}`);
      }
      seen.add(judgment.criterionId);
    }
    const evidenceIds = new Set(current.evidence.map(({ id }) => id));
    for (const judgment of input.judgments) {
      if (judgment.value === "asserted") continue;
      if (judgment.evidenceIds.length === 0) {
        return refuse(`a ${judgment.value} judgment consumes at least one piece of evidence`);
      }
      const missing = judgment.evidenceIds.find((id) => !evidenceIds.has(id));
      if (missing !== undefined) {
        return refuse(`judgment references evidence not on the WorkItem: ${missing}`);
      }
    }
    // Terminal linkage only rides evidence that passed, and worker-reported
    // settlement evidence never does: each verified judgment records durable
    // Resident verification evidence naming the predicate actually checked.
    const verificationRevision = current.completionFacts.revision + 1;
    const verificationEvidence = new Map<string, string>();
    for (const [index, judgment] of input.judgments.entries()) {
      if (judgment.value !== "verified") continue;
      const verificationId = `evidence:verification:${input.workItemId}:${verificationRevision}:${index}`;
      const written = await WorkItemStore.addEvidence(
        input.workItemId,
        {
          id: verificationId,
          kind: "custom",
          description: `resident verification: ${judgment.checkedPredicate}`,
          passed: true,
          detail: `checked evidence: ${judgment.evidenceIds.join(", ")}`,
        },
        newTraceId(),
      );
      if (written === undefined) {
        return refuse(`WorkItem vanished while recording verification: ${input.workItemId}`);
      }
      verificationEvidence.set(judgment.criterionId, verificationId);
    }
    const base = WorkItemStore.get(input.workItemId) ?? current;
    const now = options.now();
    const basisRef = base.completionContract.basisRef;
    const nextFactsRevision = base.completionFacts.revision + 1;
    const observations: WorkItem.Observation[] = [];
    const results: WorkItem.CriterionResult[] = [];
    const claims: WorkItem.Claim[] = [];
    for (const [index, judgment] of input.judgments.entries()) {
      if (judgment.value === "asserted") {
        results.push(
          WorkItem.CriterionResult.parse({
            id: `result:${input.workItemId}:${nextFactsRevision}:${index}`,
            criterionId: judgment.criterionId,
            observationIds: [],
            value: "asserted",
            assumptions: [],
            residualRisks: [],
            basisRef,
            createdAt: now,
          }),
        );
        continue;
      }
      const verificationId = verificationEvidence.get(judgment.criterionId);
      const observation = WorkItem.Observation.parse({
        id: `observation:${input.workItemId}:${nextFactsRevision}:${index}`,
        producer: "resident-completion",
        subjectRef: input.workItemId,
        basisRef,
        artifactRefs:
          verificationId === undefined
            ? [...judgment.evidenceIds]
            : [verificationId, ...judgment.evidenceIds],
        provenanceRef: verificationId ?? judgment.evidenceIds[0],
        ancestryRefs: [],
        observedAt: now,
      });
      observations.push(observation);
      if (judgment.value === "verified") {
        claims.push(
          WorkItem.Claim.parse({
            id: `claim:${input.workItemId}:${nextFactsRevision}:${index}`,
            criterionId: judgment.criterionId,
            statement: criteria.get(judgment.criterionId)?.statement ?? judgment.criterionId,
            observationIds: [observation.id],
            basisRef,
            createdAt: now,
          }),
        );
      }
      results.push(
        WorkItem.CriterionResult.parse({
          id: `result:${input.workItemId}:${nextFactsRevision}:${index}`,
          criterionId: judgment.criterionId,
          observationIds: [observation.id],
          value: judgment.value,
          checkedPredicate: judgment.checkedPredicate,
          assumptions: [],
          residualRisks: [],
          basisRef,
          createdAt: now,
        }),
      );
    }
    const verifiedCriterionIds = new Set(
      results.filter(({ value }) => value === "verified").map(({ criterionId }) => criterionId),
    );
    const refutedCriterionIds = results
      .filter(({ value }) => value === "refuted")
      .map(({ criterionId }) => criterionId);
    const unresolved = base.completionFacts.criteria
      .filter(({ id, required }) => required && !verifiedCriterionIds.has(id))
      .map(({ id }) => id);
    const admit = unresolved.length === 0 && refutedCriterionIds.length === 0;
    const report = admit
      ? WorkItem.canonicalCompletionReport(
          WorkItem.CompletionReport.parse({
            summary: `Resident verified ${verifiedCriterionIds.size} acceptance criteria for ${base.name}`,
            claims: input.judgments.flatMap((judgment) => {
              const verificationId =
                judgment.value === "verified"
                  ? verificationEvidence.get(judgment.criterionId)
                  : undefined;
              return verificationId === undefined
                ? []
                : [
                    {
                      statement: criteria.get(judgment.criterionId)?.statement ?? judgment.criterionId,
                      evidenceIds: [verificationId],
                    },
                  ];
            }),
          }),
        )
      : undefined;
    const reportRef = report === undefined ? undefined : WorkItem.completionReportReference(report);
    const requestId = `completion-request:${input.workItemId}:${base.revision}:resident`;
    const effectiveResultIds = results
      .filter(({ value }) => value === "verified")
      .map(({ id }) => id);
    const admission = WorkItem.CompletionAdmission.parse({
      version: 1,
      id: `admission:${input.workItemId}:${base.revision + 1}:resident`,
      requestId,
      workItemHash: input.workItemId,
      origin: "resident",
      contractRevision: base.completionContract.revision,
      basisRef,
      requestRoot: `request-root:${input.workItemId}:${base.revision}`,
      proposedFactIds: {
        claims: claims.map(({ id }) => id),
        observations: observations.map(({ id }) => id),
        results: results.map(({ id }) => id),
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
      effectiveResultIds,
      unresolvedCriterionIds: admit ? [] : unresolved,
      decision: admit ? "admit" : "block",
      reasonCodes: admit
        ? ["resident_verified_all_required"]
        : [
            ...(unresolved.length > 0 ? ["unverified_required_criteria"] : []),
            ...(refutedCriterionIds.length > 0 ? ["refuted_criteria"] : []),
          ],
      residualRisks: [],
      policyRef: POLICY_REF,
      ...(report === undefined
        ? {}
        : { completionReportSnapshot: report, completionReportRef: reportRef }),
      expectedHead: base.revision,
      recordedHead: base.revision + 1,
      createdAt: now,
    });
    const recorded = WorkItem.Info.parse({
      ...base,
      revision: admission.recordedHead,
      completionFacts: {
        ...base.completionFacts,
        revision: nextFactsRevision,
        claims: [...base.completionFacts.claims, ...claims],
        observations: [...base.completionFacts.observations, ...observations],
        results: [...base.completionFacts.results, ...results],
        admissions: [...base.completionFacts.admissions, admission],
      },
      timestamps: { ...base.timestamps, updated: now },
    });
    if (!options.writer(input.workItemId, base.revision, recorded)) {
      return refuse(`completion admission write lost the head race for ${input.workItemId}`);
    }
    if (!admit) {
      const why = [
        ...(unresolved.length > 0
          ? [`required criteria without a verified result: ${unresolved.join(", ")}`]
          : []),
        ...(refutedCriterionIds.length > 0
          ? [`refuted criteria: ${refutedCriterionIds.join(", ")}`]
          : []),
      ].join("; ");
      return refuse(`completion blocked — ${why}. Only verified results admit.`);
    }
    // The admission above is durable; the terminal receipt may lose a head
    // race against a concurrent writer (e.g. an attempt-close), so re-read
    // once and retry against the fresh head before giving up.
    let head = recorded;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const receipt: WorkItem.CompletionTerminalReceipt = {
        version: 1,
        hash: input.workItemId,
        requestId,
        admissionId: admission.id,
        contractRevision: admission.contractRevision,
        basisRef,
        ...(reportRef === undefined ? {} : { completionReportRef: reportRef }),
        recordedHead: head.revision + 1,
      };
      const completedAt = options.now() + 1;
      const completed = WorkItem.Info.parse({
        ...head,
        revision: head.revision + 1,
        ...(report === undefined ? {} : { completionReport: report }),
        completionTerminalReceipt: receipt,
        timestamps: { ...head.timestamps, completed: completedAt, updated: completedAt },
      });
      if (options.writer(input.workItemId, head.revision, completed)) {
        return { admitted: true, workItemId: input.workItemId };
      }
      const reread = WorkItemStore.get(input.workItemId);
      if (reread === undefined) break;
      if (reread.completionTerminalReceipt !== undefined) {
        return { admitted: true, workItemId: input.workItemId };
      }
      head = reread;
    }
    return refuse(
      `terminal receipt write lost the head race for ${input.workItemId}; the admission is recorded — re-run complete_work to finish`,
    );
  }

  return {
    list: () => WorkItemStore.list().map(summarize),
    inspect: (workItemId) => {
      const item = WorkItemStore.get(workItemId);
      return item === undefined ? undefined : summarize(item);
    },
    complete,
  };
}
