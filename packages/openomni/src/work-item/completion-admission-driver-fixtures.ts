import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import { Bus, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/session";
import { Stakes } from "../ledger/index.js";
import type {
  CompletionResultAuthorityCandidate,
  CompletionResultAuthorityPort,
  CompletionStakesResolver,
} from "./completion-admission-authority.js";

export const CompletionAdmissionDriverNow = 4_900;

export function completionAdmissionDriverWorkItem(
  hash: string,
  statements: readonly string[],
): WorkItem.Info {
  const criteria = statements.map((statement, index) => ({
    id: WorkItem.criterionId(hash, index, statement),
    revision: 1,
    statement,
    required: true,
  }));
  return WorkItem.Info.parse({
    hash,
    revision: 0,
    name: `Completion admission driver ${hash}`,
    sourceMessageId: `message:${hash}`,
    sourceChannel: "completion-admission-driver",
    attempt: 1,
    timestamps: {
      created: CompletionAdmissionDriverNow,
      updated: CompletionAdmissionDriverNow,
    },
    relations: { childHashes: [], dependsOn: [] },
    intent: "verify completion admission",
    goal: "Exercise the public WorkItem completion boundary",
    constraints: [],
    acceptanceCriteria: [...statements],
    changedFiles: [],
    blockers: [],
    evidence: [
      {
        id: `evidence:${hash}:report`,
        kind: "verification",
        description: "Deterministic completion report evidence",
        passed: true,
        attempt: 1,
        basisRef: `basis:${hash}:v1`,
        createdAt: CompletionAdmissionDriverNow,
      },
    ],
    completionContract: { version: 1, revision: "driver-v1", basisRef: `basis:${hash}:v1` },
    completionFacts: { ...WorkItem.emptyCompletionFacts(), criteria },
  });
}

export function completionAdmissionDriverRequest(
  item: WorkItem.Info,
  id: string,
  facts: Partial<
    Pick<
      WorkItem.CompletionRequest,
      "claims" | "observations" | "results" | "invalidations" | "verificationErrors" | "effects"
    >
  > = {},
): WorkItem.CompletionRequest {
  const observations = [...(facts.observations ?? [])];
  const results = (facts.results ?? []).map((result) => {
    if (result.observationIds.length > 0) return result;
    const observation: WorkItem.Observation = {
      id: `observation:${id}:${result.id}`,
      producer: "completion-admission-driver",
      subjectRef: item.hash,
      basisRef: item.completionContract.basisRef,
      artifactRefs: [`evidence:${item.hash}:report`],
      ancestryRefs: [],
      observedAt: CompletionAdmissionDriverNow,
    };
    observations.push(observation);
    return { ...result, observationIds: [observation.id] };
  });
  const claims =
    facts.claims ??
    results.map((result) => {
      const criterion = item.completionFacts.criteria.find(({ id: criterionId }) => {
        return criterionId === result.criterionId;
      });
      if (!criterion) throw new Error(`missing driver criterion ${result.criterionId}`);
      return {
        id: `claim:${id}:${result.id}`,
        criterionId: criterion.id,
        statement: criterion.statement,
        observationIds: result.observationIds,
        basisRef: item.completionContract.basisRef,
        createdAt: CompletionAdmissionDriverNow,
      };
    });
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id,
    origin: "worker",
    workItemHash: item.hash,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    expectedHead: item.revision,
    claims,
    observations,
    results,
    invalidations: facts.invalidations ?? [],
    verificationErrors: facts.verificationErrors ?? [],
    effects: facts.effects ?? [],
  });
}

export function completionAdmissionDriverProposedFacts(request: WorkItem.CompletionRequest) {
  return {
    claims: request.claims,
    observations: request.observations,
    results: request.results,
    invalidations: request.invalidations,
    verificationErrors: request.verificationErrors,
    effects: request.effects,
  };
}

export function completionAdmissionDriverAssertedResult(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  id: string,
  residualRisks: readonly string[],
): WorkItem.CriterionResult {
  return WorkItem.CriterionResult.parse({
    id,
    criterionId: criterion.id,
    value: "asserted",
    observationIds: [],
    assumptions: ["claimant supplied this assertion"],
    basisRef: item.completionContract.basisRef,
    residualRisks,
    createdAt: CompletionAdmissionDriverNow,
  });
}

export function completionAdmissionDriverAssertedPolicy(criterionId: string) {
  const engine = PolicyEngine.create();
  engine.register({
    kind: "point",
    name: "driver-low-asserted-allow",
    pointIds: ["work.complete.pre"],
    effectCapabilities: { "work.complete.pre": ["work.allow_asserted"] },
    priority: 0,
    fn: () =>
      PolicyDecision.allow({
        policyId: "policy:driver-low-asserted",
        effects: [{ type: "work.allow_asserted", criterionIds: [criterionId] }],
      }),
  });
  return engine;
}

export function completionAdmissionDriverHighStakes() {
  const window = Stakes.createWindow({
    ownerKey: "owner:completion-admission-driver",
    windowId: "window:completion-admission-driver",
    openedAt: 1,
    closesAt: 10_000,
  });
  return Stakes.compute(
    {
      actionId: "action:completion-admission-driver-high",
      ownerKey: window.ownerKey,
      windowRef: window.windowRef,
      ledgerObservedAt: CompletionAdmissionDriverNow,
      facts: {
        irreversibleChangeCount: 10,
        externalSurfaceCount: 10,
        spendMicros: 100_000_000,
        budgetReservedMicros: 100_000_000,
        outreachRecipientCount: 10,
        contentFingerprints: [
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      },
    },
    { window, actions: [], knownFingerprints: [] },
  );
}

function completionAdmissionDriverLowStakes() {
  const window = Stakes.createWindow({
    ownerKey: "owner:completion-admission-driver",
    windowId: "window:completion-admission-driver-low",
    openedAt: 1,
    closesAt: 10_000,
  });
  return Stakes.compute(
    {
      actionId: "action:completion-admission-driver-low",
      ownerKey: window.ownerKey,
      windowRef: window.windowRef,
      ledgerObservedAt: CompletionAdmissionDriverNow,
      facts: {
        irreversibleChangeCount: 0,
        externalSurfaceCount: 0,
        spendMicros: 0,
        budgetReservedMicros: 0,
        outreachRecipientCount: 0,
        contentFingerprints: [
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
      },
    },
    { window, actions: [], knownFingerprints: [] },
  );
}

export function completionAdmissionDriverLowStakesResolver(): CompletionStakesResolver {
  return {
    resolve(subject) {
      return {
        ok: true,
        context: {
          surface: "work.complete.pre",
          workItemHash: subject.workItemHash,
          requestId: subject.requestId,
          contractRevision: subject.contractRevision,
          basisRef: subject.basisRef,
          expectedHead: subject.expectedHead,
          stakes: completionAdmissionDriverLowStakes(),
        },
      };
    },
  };
}

export function completionAdmissionDriverVerifierPort(
  criterion: WorkItem.Criterion,
  result: WorkItem.CriterionResult,
  observations: readonly WorkItem.Observation[],
): CompletionResultAuthorityPort {
  return Object.freeze({
    validate(candidate: CompletionResultAuthorityCandidate) {
      return {
        ok:
          canonical(candidate.criterion) === canonical(criterion) &&
          canonical(candidate.result) === canonical(result) &&
          canonical(candidate.observations) === canonical(observations),
      };
    },
  });
}

export function completionAdmissionDriverReport(item: WorkItem.Info): WorkItem.CompletionReport {
  const criterion = completionAdmissionDriverCriterion(item, 0);
  return {
    summary: "Completion admission driver report",
    claims: [
      {
        statement: criterion.statement,
        evidenceIds: [`evidence:${item.hash}:report`],
      },
    ],
    caveats: [],
    followUps: [],
  };
}

export function completionAdmissionDriverCriterion(
  item: WorkItem.Info,
  index: number,
): WorkItem.Criterion {
  const criterion = item.completionFacts.criteria[index];
  if (!criterion) throw new Error(`missing driver criterion ${index}`);
  return criterion;
}

export function insertCompletionAdmissionDriverItem(
  adapter: SqliteStorageAdapter,
  item: WorkItem.Info,
): void {
  if (!adapter.workItem.create(item.hash, item)) {
    throw new Error(`could not insert driver WorkItem ${item.hash}`);
  }
}

export function requiredCompletionAdmissionDriverItem(hash: string): WorkItem.Info {
  const item = WorkItemStore.get(hash);
  if (!item) throw new Error(`missing stored driver WorkItem ${hash}`);
  return item;
}

export async function withCompletionAdmissionDriverStorage<T>(
  operation: (
    adapter: SqliteStorageAdapter,
    completionWriter: Storage.WorkItemCompletionWriter,
  ) => Promise<T>,
): Promise<T> {
  Bus.reset();
  const adapter = new SqliteStorageAdapter(":memory:");
  const completionWriter = Storage.configure(adapter);
  try {
    return await operation(adapter, completionWriter);
  } finally {
    adapter.close();
    Storage.reset();
    Bus.reset();
  }
}

export async function captureCompletionAdmissionDriverCode<T extends Error>(
  operation: Promise<unknown>,
  expectedType: new (...args: never[]) => T,
): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof expectedType)) throw error;
    return Reflect.get(error, "code");
  }
  return undefined;
}

export async function captureCompletionAdmissionDriverMessage(
  operation: Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expected)) throw error;
    return;
  }
  throw new Error(`expected failure containing: ${expected}`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}
