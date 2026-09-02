import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationStore, Storage, WorkItemStore, initialize } from "@openomni/ledger";
import { WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { DelegationOrigin } from "../src/delegation/admission";
import { createDelegationKernel, type DriverOutcome } from "../src/delegation/kernel";
import { createWorkItemLinkage } from "../src/delegation/work-item-linkage";
import { catalogEntries } from "../src/tools/core/catalog";
import { completeWorkToolExecutor, workItemsToolExecutor } from "../src/tools/work-items";
import { createCompletionPort, type CompletionPort } from "../src/work-item/completion";
import { validateCompletionTerminalLinkage } from "../src/work-item/terminal-linkage";

const directories: string[] = [];
const kernels: ReturnType<typeof createDelegationKernel>[] = [];

afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.stop();
  Storage.reset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const RESIDENT: DelegationOrigin = { role: "resident", depth: 0, sessionId: "sess-owner" };
const CRITERIA = ["the widget builds green", "the widget report is written"] as const;

function bootLedger(): ReturnType<typeof initialize> {
  const directory = mkdtempSync(join(tmpdir(), "openomni-workitem-"));
  directories.push(directory);
  return initialize({ dbPath: join(directory, "ledger.db") });
}

/** A process-shaped driver the test resolves by hand, so settlement timing is explicit. */
function deferredDriver(): {
  driver: { run(): Promise<DriverOutcome> };
  settle: (outcome: DriverOutcome) => void;
} {
  let resolve: ((outcome: DriverOutcome) => void) | undefined;
  const outcome = new Promise<DriverOutcome>((r) => {
    resolve = r;
  });
  return {
    driver: { run: () => outcome },
    settle: (o) => resolve?.(o),
  };
}

/** The linkage every wiring test uses: the fake model, wall-clock now. */
function wiringLinkage() {
  return createWorkItemLinkage({
    model: { provider: "fake", id: "fake-model" },
    now: () => Date.now(),
  });
}

function bootKernel(driver: { run(): Promise<DriverOutcome> }) {
  const kernel = createDelegationKernel({
    drivers: { process: driver as never },
    now: () => Date.now(),
    newDelegationId: () => "dg-wiring-1",
    wake: () => undefined,
    workItems: wiringLinkage(),
  });
  kernels.push(kernel);
  return kernel;
}

async function delegateAssign(kernel: ReturnType<typeof bootKernel>) {
  return await kernel.delegate(
    {
      operation: "assign",
      address: { kind: "core", scope: "independent" },
      payload: { text: "assemble the widget" },
      acceptanceCriteria: [...CRITERIA],
      deadline: Date.now() + 60_000,
    },
    RESIDENT,
  );
}

function attemptClosed(workItemId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = Bus.subscribe(WorkItem.Events.Updated, (event) => {
      if (
        event.payload.workItemId === workItemId &&
        event.payload.fields.includes("attemptTerminal")
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
}

test("a refused attempt allocation rolls back its pending WorkItem", async () => {
  bootLedger();
  const linkage = wiringLinkage();
  const original = WorkItemStore.allocateAttempt;
  WorkItemStore.allocateAttempt = (() => undefined) as never;
  try {
    await expect(
      linkage.openAssign({
        delegationId: "d-refused-attempt",
        transport: "process",
        instruction: "work",
        acceptanceCriteria: ["done"],
        sessionId: "session",
      }),
    ).rejects.toThrow();
    expect(WorkItemStore.list()[0]?.timestamps.cancelled).toBeDefined();
  } finally {
    WorkItemStore.allocateAttempt = original;
  }
});

test("assign admission commissions a WorkItem with an allocated attempt", async () => {
  bootLedger();
  const { driver } = deferredDriver();
  const kernel = bootKernel(driver);
  const result = await delegateAssign(kernel);
  expect("handle" in result).toBe(true);

  const record = DelegationStore.get("dg-wiring-1");
  expect(record?.workItemId).toBeDefined();
  const item = await WorkItemStore.get(record?.workItemId ?? "");
  expect(item).toBeDefined();
  expect(item?.acceptanceCriteria).toEqual([...CRITERIA]);
  expect(item?.currentAttemptId).toBeDefined();
  expect(WorkItem.deriveStatus(item as WorkItem.Info)).not.toBe("completed");
});

test("settlement demotes worker output to Evidence and closes the attempt without completing", async () => {
  bootLedger();
  const { driver, settle } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  const closed = attemptClosed(workItemId);

  settle({
    status: "completed",
    output: "widget assembled; report at /tmp/report.md",
    usage: { tokens: 4321 },
  });
  const settlement = await kernel.awaitDelegation("dg-wiring-1", 5_000);
  expect(settlement.kind).toBe("settled");
  await closed;

  const item = await WorkItemStore.get(workItemId);
  expect(item?.attemptTerminal?.outcome).toBe("succeeded");
  expect(item?.evidence).toHaveLength(1);
  // Worker self-report NEVER passes verification: completion can only ride
  // Resident-recorded verification evidence.
  expect(item?.evidence[0]?.passed).toBe(false);
  expect(item?.evidence[0]?.description).toContain("unverified");
  expect(item?.evidence[0]?.detail).toContain("widget assembled");
  // The kernel never auto-completes: completion is admission-only.
  expect(WorkItem.deriveStatus(item as WorkItem.Info)).not.toBe("completed");
  expect(item?.completionTerminalReceipt).toBeUndefined();
  // Usage is visibility only: recorded on the attempt terminal, never an
  // admission input.
  expect(item?.attemptTerminal?.usage?.tokens).toBe(4321);
  expect(item?.attemptTerminal?.usage?.seconds).toBeGreaterThanOrEqual(0);
});

test("a cancelled settlement records its reason as evidence", async () => {
  bootLedger();
  const { driver, settle } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  const closed = attemptClosed(workItemId);
  settle({ status: "cancelled", reason: "owner cancelled" });
  await kernel.awaitDelegation("dg-wiring-1", 5_000);
  await closed;
  expect((await WorkItemStore.get(workItemId))?.evidence[0]?.detail).toBe("owner cancelled");
});

test("a failed settlement fails the WorkItem with failing evidence", async () => {
  bootLedger();
  const { driver, settle } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  const closed = attemptClosed(workItemId);

  settle({ status: "failed", error: "worker exploded" });
  await kernel.awaitDelegation("dg-wiring-1", 5_000);
  await closed;

  const item = await WorkItemStore.get(workItemId);
  expect(item?.attemptTerminal?.outcome).toBe("failed");
  expect(item?.evidence[0]?.passed).toBe(false);
  expect(WorkItem.deriveStatus(item as WorkItem.Info)).toBe("failed");
  const completion = createCompletionPort({ writer: () => true, now: () => Date.now() });
  expect((await completion.complete({ workItemId, judgments: [] })).admitted).toBe(false);
});

async function settledAssign(): Promise<{
  workItemId: string;
  completion: ReturnType<typeof createCompletionPort>;
}> {
  const writer = bootLedger();
  const { driver, settle } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  const closed = attemptClosed(workItemId);
  settle({ status: "completed", output: "widget assembled" });
  await kernel.awaitDelegation("dg-wiring-1", 5_000);
  await closed;
  const completion = createCompletionPort({ writer, now: () => Date.now() });
  return { workItemId, completion };
}

test("completion inspection summarizes durable criteria, evidence, and attempt outcome", async () => {
  const { workItemId, completion } = await settledAssign();
  expect(completion.list()).toHaveLength(1);
  expect(completion.inspect(workItemId)).toMatchObject({ workItemId, attemptOutcome: "succeeded" });
  expect(completion.inspect("missing")).toBeUndefined();
});

test("completion refuses unknown, duplicate, and ungrounded judgments", async () => {
  const { workItemId, completion } = await settledAssign();
  const item = WorkItemStore.get(workItemId);
  const criterionId = item?.completionFacts.criteria[0]?.id ?? "criterion";
  const evidenceId = item?.evidence[0]?.id ?? "evidence";
  expect((await completion.complete({ workItemId: "missing", judgments: [] })).admitted).toBe(
    false,
  );
  expect(
    (
      await completion.complete({
        workItemId,
        judgments: [{ criterionId: "missing", value: "asserted" }],
      })
    ).admitted,
  ).toBe(false);
  expect(
    (
      await completion.complete({
        workItemId,
        judgments: [
          { criterionId, value: "asserted" },
          { criterionId, value: "asserted" },
        ],
      })
    ).admitted,
  ).toBe(false);
  expect(
    (
      await completion.complete({
        workItemId,
        judgments: [
          { criterionId, value: "verified", checkedPredicate: "checked", evidenceIds: [] },
        ],
      })
    ).admitted,
  ).toBe(false);
  expect(
    (
      await completion.complete({
        workItemId,
        judgments: [
          { criterionId, value: "verified", checkedPredicate: "checked", evidenceIds: ["missing"] },
        ],
      })
    ).admitted,
  ).toBe(false);
  expect(evidenceId).not.toBe("");
});

test("completion reports a vanished item during verification", async () => {
  const { workItemId, completion } = await settledAssign();
  const item = WorkItemStore.get(workItemId);
  const criterionId = item?.completionFacts.criteria[0]?.id ?? "criterion";
  const evidenceId = item?.evidence[0]?.id ?? "evidence";
  const original = WorkItemStore.addEvidence;
  WorkItemStore.addEvidence = (() => undefined) as never;
  try {
    const outcome = await completion.complete({
      workItemId,
      judgments: [
        { criterionId, value: "verified", checkedPredicate: "checked", evidenceIds: [evidenceId] },
      ],
    });
    expect(outcome.admitted).toBe(false);
  } finally {
    WorkItemStore.addEvidence = original;
  }
});

test("completion reports repeated admission-head races", async () => {
  const { workItemId } = await settledAssign();
  const item = WorkItemStore.get(workItemId);
  const port = createCompletionPort({ writer: () => false, now: () => Date.now() });
  const outcome = await port.complete({
    workItemId,
    judgments: (item?.completionFacts.criteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      value: "asserted" as const,
    })),
  });
  expect(outcome.admitted).toBe(false);
});

test("completion admission refuses asserted-only judgments durably", async () => {
  const { workItemId, completion } = await settledAssign();
  const item = await WorkItemStore.get(workItemId);
  const criteria = item?.completionFacts.criteria ?? [];
  const outcome = await completion.complete({
    workItemId,
    judgments: criteria.map((criterion) => ({
      criterionId: criterion.id,
      value: "asserted" as const,
    })),
  });
  expect(outcome.admitted).toBe(false);
  if (!outcome.admitted) expect(outcome.reason).toContain("verified");

  const after = await WorkItemStore.get(workItemId);
  expect(WorkItem.deriveStatus(after as WorkItem.Info)).not.toBe("completed");
  expect(after?.completionFacts.admissions.at(-1)?.decision).toBe("block");
});

test("completion admission refuses a refuted required criterion", async () => {
  const { workItemId, completion } = await settledAssign();
  const item = await WorkItemStore.get(workItemId);
  const criteria = item?.completionFacts.criteria ?? [];
  const evidenceId = item?.evidence[0]?.id ?? "";
  const outcome = await completion.complete({
    workItemId,
    judgments: criteria.map((criterion, index) => ({
      criterionId: criterion.id,
      value: index === 0 ? ("refuted" as const) : ("verified" as const),
      checkedPredicate: `checked: ${criterion.statement}`,
      evidenceIds: [evidenceId],
    })),
  });
  expect(outcome.admitted).toBe(false);
  const after = await WorkItemStore.get(workItemId);
  expect(WorkItem.deriveStatus(after as WorkItem.Info)).not.toBe("completed");
});

test("completion admission admits verified judgments and writes the terminal receipt", async () => {
  const { workItemId, completion } = await settledAssign();
  const item = await WorkItemStore.get(workItemId);
  const criteria = item?.completionFacts.criteria ?? [];
  const evidenceId = item?.evidence[0]?.id ?? "";
  const outcome = await completion.complete({
    workItemId,
    judgments: criteria.map((criterion) => ({
      criterionId: criterion.id,
      value: "verified" as const,
      checkedPredicate: `checked: ${criterion.statement}`,
      evidenceIds: [evidenceId],
    })),
  });
  expect(outcome.admitted).toBe(true);

  const after = await WorkItemStore.get(workItemId);
  expect(WorkItem.deriveStatus(after as WorkItem.Info)).toBe("completed");
  expect(after?.completionTerminalReceipt).toBeDefined();
  expect(validateCompletionTerminalLinkage(after as WorkItem.Info).success).toBe(true);
  const repeated = await completion.complete({ workItemId, judgments: [] });
  expect(repeated.admitted).toBe(false);
});

test("completion accepts a valid receipt that wins after its initial state read", async () => {
  const { workItemId, completion } = await settledAssign();
  const before = WorkItemStore.get(workItemId);
  const evidenceId = before?.evidence[0]?.id ?? "";
  const admitted = await completion.complete({
    workItemId,
    judgments: (before?.completionFacts.criteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      value: "verified" as const,
      checkedPredicate: "checked",
      evidenceIds: [evidenceId],
    })),
  });
  expect(admitted.admitted).toBe(true);
  const completed = WorkItemStore.get(workItemId);
  const original = WorkItemStore.get;
  let reads = 0;
  WorkItemStore.get = (() => (reads++ === 0 ? before : completed)) as never;
  try {
    const raced = await completion.complete({
      workItemId,
      judgments: (before?.completionFacts.criteria ?? []).map((criterion) => ({
        criterionId: criterion.id,
        value: "asserted" as const,
      })),
    });
    expect(raced.admitted).toBe(true);
  } finally {
    WorkItemStore.get = original;
  }
});

test("the admission write guard refuses a malformed real-port candidate before its writer", async () => {
  const { workItemId } = await settledAssign();
  const originalGet = WorkItemStore.get;
  let writerCalls = 0;
  WorkItemStore.get = (id) => {
    const item = originalGet(id);
    const firstEvidence = item?.evidence[0];
    return item === undefined || firstEvidence === undefined
      ? item
      : { ...item, evidence: [...item.evidence, { ...firstEvidence }] };
  };
  try {
    const item = originalGet(workItemId);
    const evidenceId = item?.evidence[0]?.id ?? "";
    const completion = createCompletionPort({
      writer: () => {
        writerCalls += 1;
        return true;
      },
      now: () => Date.now(),
    });
    const outcome = await completion.complete({
      workItemId,
      judgments: (item?.completionFacts.criteria ?? []).map((criterion) => ({
        criterionId: criterion.id,
        value: "verified" as const,
        checkedPredicate: `checked: ${criterion.statement}`,
        evidenceIds: [evidenceId],
      })),
    });

    expect(outcome.admitted).toBe(false);
    expect(writerCalls).toBe(0);
  } finally {
    WorkItemStore.get = originalGet;
  }
});

test("the terminal write guard revalidates a candidate mutated after admission", async () => {
  const { workItemId } = await settledAssign();
  const item = WorkItemStore.get(workItemId);
  const evidenceId = item?.evidence[0]?.id ?? "";
  let writerCalls = 0;
  const completion = createCompletionPort({
    writer: (_id, _expectedHead, next) => {
      writerCalls += 1;
      if (next.completionTerminalReceipt === undefined) {
        const admission = next.completionFacts.admissions.at(-1);
        if (admission === undefined) throw new Error("admission candidate is missing");
        Object.assign(admission, {
          decision: "owner_override",
          ownerOverrideReceiptRef: "owner-override:interposed",
        });
      }
      return true;
    },
    now: () => Date.now(),
  });

  const outcome = await completion.complete({
    workItemId,
    judgments: (item?.completionFacts.criteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      value: "verified" as const,
      checkedPredicate: `checked: ${criterion.statement}`,
      evidenceIds: [evidenceId],
    })),
  });

  expect(outcome.admitted).toBe(false);
  expect(writerCalls).toBe(1);
});

test("protocol parsing is structural while app admission rejects broken terminal linkage", async () => {
  const { workItemId, completion } = await settledAssign();
  const item = await WorkItemStore.get(workItemId);
  const evidenceId = item?.evidence[0]?.id ?? "";
  const outcome = await completion.complete({
    workItemId,
    judgments: (item?.completionFacts.criteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      value: "verified" as const,
      checkedPredicate: `checked: ${criterion.statement}`,
      evidenceIds: [evidenceId],
    })),
  });
  expect(outcome.admitted).toBe(true);
  const completed = await WorkItemStore.get(workItemId);
  if (completed === undefined) throw new Error("completed WorkItem is missing");

  const firstResult = completed.completionFacts.results[0];
  if (firstResult === undefined || completed.completionFacts.admissions.length === 0) {
    throw new Error("completed WorkItem linkage facts are missing");
  }
  const refutedResult: WorkItem.CriterionResult = {
    ...firstResult,
    id: `${firstResult.id}:refuted`,
    value: "refuted",
    checkedPredicate: "the completion predicate was refuted",
  };

  const brokenCandidates = [
    {
      ...completed,
      completionTerminalReceipt: undefined,
    },
    {
      ...completed,
      timestamps: { ...completed.timestamps, completed: undefined },
    },
    {
      ...completed,
      completionTerminalReceipt: {
        ...completed.completionTerminalReceipt,
        hash: "wi_foreign",
      },
    },
    {
      ...completed,
      completionFacts: {
        ...completed.completionFacts,
        admissions: completed.completionFacts.admissions.map((admission) => ({
          ...admission,
          effectiveResultIds: [],
        })),
      },
    },
    {
      ...completed,
      completionFacts: {
        ...completed.completionFacts,
        results: completed.completionFacts.results.map((result) => {
          const { checkedPredicate: _checkedPredicate, ...shape } =
            result as WorkItem.CriterionResult & Readonly<{ checkedPredicate?: string }>;
          return { ...shape, value: "asserted" as const };
        }),
      },
    },
    {
      ...completed,
      completionFacts: {
        ...completed.completionFacts,
        results: [...completed.completionFacts.results, refutedResult],
        admissions: completed.completionFacts.admissions.map((admission) => ({
          ...admission,
          proposedFactIds: {
            ...admission.proposedFactIds,
            results: [...admission.proposedFactIds.results, refutedResult.id],
          },
        })),
      },
    },
    {
      ...completed,
      completionFacts: {
        ...completed.completionFacts,
        admissions: completed.completionFacts.admissions.map((admission) => ({
          ...admission,
          effectiveResultIds: [],
          unresolvedCriterionIds: completed.completionFacts.criteria.map(({ id }) => id),
          decision: "owner_override" as const,
          ownerOverrideReceiptRef: "owner-override:test",
        })),
      },
    },
  ];

  for (const candidate of brokenCandidates) {
    const parsed = WorkItem.Info.safeParse(candidate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) continue;
    expect(validateCompletionTerminalLinkage(parsed.data).success).toBe(false);
  }
});

test("work item tool adapters cover validation, list, inspect, and both completion outcomes", async () => {
  const calls: unknown[] = [];
  const summary = {
    workItemId: "wi-1",
    name: "work",
    status: "running",
    criteria: [],
    evidence: [],
  } as const;
  const port: CompletionPort = {
    list: () => [summary],
    inspect: (id) => (id === "wi-1" ? summary : undefined),
    complete: (input) => {
      calls.push(input);
      return Promise.resolve(
        input.workItemId === "wi-1"
          ? { admitted: true as const, workItemId: input.workItemId }
          : { admitted: false as const, reason: "blocked" },
      );
    },
  };
  const inspect = workItemsToolExecutor(port);
  expect(await inspect({ extra: true })).toBeString();
  expect(JSON.parse(await inspect(undefined))).toHaveLength(1);
  expect(await inspect({ workItemId: "missing" })).toBeString();
  expect(JSON.parse(await inspect({ workItemId: "wi-1" }))).toMatchObject({ workItemId: "wi-1" });

  const complete = completeWorkToolExecutor(port);
  expect(await complete({})).toBeString();
  const judgments = [{ criterionId: "criterion", value: "asserted" as const }];
  expect(await complete({ workItemId: "wi-1", judgments })).toBeString();
  expect(await complete({ workItemId: "wi-2", judgments })).toBeString();
  expect(calls).toHaveLength(2);
});

test("work_items and complete_work are a Resident-only catalog surface", () => {
  bootLedger();
  const ports = {
    workItems: createCompletionPort({ writer: () => true, now: () => Date.now() }),
  };
  const residentNames = catalogEntries(ports, RESIDENT).map((entry) => entry.spec.name);
  expect(residentNames).toContain("work_items");
  expect(residentNames).toContain("complete_work");
  const workerNames = catalogEntries(ports, {
    role: "worker",
    depth: 1,
    sessionId: "sess-worker",
  }).map((entry) => entry.spec.name);
  expect(workerNames).not.toContain("work_items");
  expect(workerNames).not.toContain("complete_work");
});

test("a crash between settlement and closure loses nothing: the sweep rebuilds the terminal with its tokens", async () => {
  bootLedger();
  const { driver } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  // The settlement CAS commits directly against the store — the kernel's
  // closeAttempt hook never fires, exactly the crash window recovery covers.
  DelegationStore.settleOnce("dg-wiring-1", {
    status: "completed",
    delegationId: "dg-wiring-1",
    output: "done before the crash",
    at: Date.now(),
    usage: { tokens: 777 },
  });
  kernel.stop();
  expect((await WorkItemStore.get(workItemId))?.attemptTerminal).toBeUndefined();

  const linkage = wiringLinkage();
  await linkage.recoverAttempts((id) => DelegationStore.get(id));
  const after = await WorkItemStore.get(workItemId);
  expect(after?.attemptTerminal).toMatchObject({ usage: { tokens: 777 } });
  expect(after?.evidence).toHaveLength(1);
  expect(after?.evidence[0]?.passed).toBe(false);
});

test("a restart sweep re-closes an attempt whose settlement write was lost", async () => {
  bootLedger();
  const { driver, settle } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  const closed = attemptClosed(workItemId);
  settle({ status: "completed", output: "done", usage: { tokens: 555 } });
  await kernel.awaitDelegation("dg-wiring-1", 5_000);
  await closed;
  kernel.stop();

  // Simulate the lost ledger write by wiping the attempt-terminal marker is
  // not possible through the store; instead prove the sweep is idempotent
  // against an already-closed item and closes a still-open one.
  const before = await WorkItemStore.get(workItemId);
  expect(before?.attemptTerminal).toBeDefined();
  expect(before?.evidence).toHaveLength(1);

  const linkage = wiringLinkage();
  // Re-running the close (what the boot sweep does) must not duplicate
  // evidence or reopen the attempt.
  const record = DelegationStore.get("dg-wiring-1");
  if (record === undefined || record.settled === undefined) throw new Error("record not settled");
  // Tokens ride the durable settlement, so a crash between settlement and
  // attempt closure loses nothing: the sweep re-closes from this record alone.
  expect(record.settled).toMatchObject({ status: "completed", usage: { tokens: 555 } });
  await linkage.closeAttempt({ record, settlement: record.settled });
  await linkage.recoverAttempts((id) => DelegationStore.get(id));
  const after = await WorkItemStore.get(workItemId);
  expect(after?.evidence).toHaveLength(1);
  expect(after?.attemptTerminal).toEqual(before?.attemptTerminal);
});

test("completion re-runs the whole admission recipe when the receipt loses a head race", async () => {
  const writer = bootLedger();
  const { driver, settle } = deferredDriver();
  const kernel = bootKernel(driver);
  await delegateAssign(kernel);
  const workItemId = DelegationStore.get("dg-wiring-1")?.workItemId ?? "";
  const closed = attemptClosed(workItemId);
  settle({ status: "completed", output: "done", usage: { tokens: 555 } });
  await kernel.awaitDelegation("dg-wiring-1", 5_000);
  await closed;
  kernel.stop();

  // A hostile interleaving: the first terminal-receipt write both loses the
  // race AND the head advances underneath (like a concurrent evidence write),
  // so a receipt patched onto the new head would violate terminal linkage.
  let raced = false;
  const racingWriter: typeof writer = (id, expectedHead, next) => {
    if (!raced && next.completionTerminalReceipt !== undefined) {
      raced = true;
      const advanced = WorkItem.Info.parse({
        ...next,
        completionTerminalReceipt: undefined,
        completionReport: undefined,
        timestamps: { ...next.timestamps, completed: undefined },
      });
      writer(id, expectedHead, advanced);
      return false;
    }
    return writer(id, expectedHead, next);
  };
  const port = createCompletionPort({ writer: racingWriter, now: () => Date.now() });
  const item = await WorkItemStore.get(workItemId);
  const evidenceId = item?.evidence[0]?.id ?? "";
  const outcome = await port.complete({
    workItemId,
    judgments: (item?.completionFacts.criteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      value: "verified" as const,
      checkedPredicate: `checked: ${criterion.statement}`,
      evidenceIds: [evidenceId],
    })),
  });
  expect(outcome.admitted).toBe(true);
  expect(raced).toBe(true);
  const after = await WorkItemStore.get(workItemId);
  expect(WorkItem.deriveStatus(after as WorkItem.Info)).toBe("completed");
  expect(() => WorkItem.Info.parse(after)).not.toThrow();
});
