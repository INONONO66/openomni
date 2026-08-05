import { describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Bus, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/session";
import * as OpenOmni from "../../src/index.js";
import { completionAdmissionScenarioReceipt } from "../../src/work-item/completion-admission-driver-contract.js";
import { runAllOriginsCompletionAdmissionScenario } from "../../src/work-item/completion-admission-driver-origin-scenarios.js";
import * as WorkItemPublic from "../../src/work-item/index.js";

const SCENARIOS = [
  "known-bad",
  "low-asserted-high-escalation",
  "all-origins",
  "stale-basis",
  "restart-recovery",
  "bypass-refusal",
  "legacy-archive",
] as const;

type Scenario = (typeof SCENARIOS)[number];
type DriverExecution = Readonly<{ exitCode: 0 | 1; stdout: string }>;
type Driver = (args: readonly string[]) => Promise<DriverExecution>;

function publicDriver(): Driver {
  const rootDriver = Reflect.get(OpenOmni, "runCompletionAdmissionDriver");
  const domainDriver = Reflect.get(WorkItemPublic, "runCompletionAdmissionDriver");
  expect(rootDriver, "package root must export runCompletionAdmissionDriver").toBeFunction();
  expect(domainDriver, "work-item barrel must export runCompletionAdmissionDriver").toBe(
    rootDriver,
  );
  if (typeof rootDriver !== "function") throw new Error("missing completion admission driver");
  return rootDriver as Driver;
}

async function scenarioReceipt(scenario: Scenario): Promise<Record<string, unknown>> {
  const execution = await publicDriver()(["--scenario", scenario, "--json"]);
  expect(execution.exitCode).toBe(0);
  const receipt = parseObject(execution.stdout);
  expect(receipt).toMatchObject({
    version: "completion-admission-driver-v1",
    mode: "scenario",
    scenario,
    ok: true,
  });
  expect(receipt.resultCode).toBeString();
  return receipt;
}

describe("WorkItem completion admission driver", () => {
  test("preserves host Storage and Bus state across an embedded scenario", async () => {
    const hostAdapter = new SqliteStorageAdapter(":memory:");
    Storage.configure(hostAdapter);
    let createdEvents = 0;
    const unsubscribe = Bus.subscribe(WorkItem.Events.Created, () => {
      createdEvents += 1;
    });
    try {
      const hostItem = await WorkItemStore.create({
        name: "Host state sentinel",
        sourceMessageId: "msg_host_sentinel",
        sourceChannel: "test",
        intent: "preserve",
        goal: "prove the public driver cannot clobber its host",
        acceptanceCriteria: ["host state remains available"],
      });

      const execution = await publicDriver()(["--scenario", "known-bad", "--json"]);
      await Promise.resolve();

      expect(execution.exitCode).toBe(0);
      expect(Storage.get()).toBe(hostAdapter);
      expect(WorkItemStore.get(hostItem.hash)?.name).toBe("Host state sentinel");
      expect(Bus.stats().subscriberCount).toBe(1);
      await WorkItemStore.create({
        name: "Host event sentinel",
        sourceMessageId: "msg_host_event",
        sourceChannel: "test",
        intent: "observe",
        goal: "prove the host subscription remains active",
        acceptanceCriteria: ["host subscriber receives this event"],
      });
      await Promise.resolve();
      expect(createdEvents).toBe(2);
    } finally {
      unsubscribe();
      hostAdapter.close();
      Storage.reset();
      Bus.reset();
    }
  });

  test("publishes deterministic help and argument_error receipts", async () => {
    const run = publicDriver();
    const help = await run(["--help"]);
    const invalid = await run(["--scenario", "unknown", "--json"]);

    expect(help).toEqual({
      exitCode: 0,
      stdout:
        "Usage: completion-admission-driver --self-test | --scenario <known-bad|low-asserted-high-escalation|all-origins|stale-basis|restart-recovery|bypass-refusal|legacy-archive> --json",
    });
    expect(invalid.exitCode).toBe(1);
    expect(parseObject(invalid.stdout)).toEqual({
      version: "completion-admission-driver-v1",
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    });
  });

  test("does not allow scenario fields to override the receipt envelope", () => {
    const receipt = completionAdmissionScenarioReceipt(
      "known-bad",
      true,
      "expected_success",
      "unexpected_failure",
      {
        version: "forged-version",
        mode: "forged-mode",
        scenario: "legacy-archive",
        ok: false,
        resultCode: "forged-result",
        preservedField: "preserved",
      },
    );

    expect(receipt).toMatchObject({
      version: "completion-admission-driver-v1",
      mode: "scenario",
      scenario: "known-bad",
      ok: true,
      resultCode: "expected_success",
      preservedField: "preserved",
    });
  });

  test("blocks a real verifier refutation without terminal or effect mutation", async () => {
    const receipt = await scenarioReceipt("known-bad");
    expect(receipt).toMatchObject({
      resultCode: "known_bad_blocked",
      blocked: true,
      status: "incomplete",
      result: {
        value: "refuted",
        checkedPredicate: "recorded numeric operands satisfy lt",
      },
      predicateBoundToCriterion: true,
      admission: {
        decision: "block",
        reasonCodes: expect.arrayContaining(["required_result_refuted"]),
      },
      workItem: {
        status: "pending",
        completed: false,
        effectCount: 0,
        admissionCount: 1,
        terminalReceiptLinked: false,
      },
    });
    expect(parseObject(receipt.result).checkedPredicate).toBe(
      "recorded numeric operands satisfy lt",
    );
  });

  test("keeps asserted facts asserted while policy admits low risk and Stakes escalates high risk", async () => {
    const receipt = await scenarioReceipt("low-asserted-high-escalation");
    expect(receipt).toMatchObject({
      resultCode: "asserted_policy_and_stakes_verified",
      low: {
        resultValue: "asserted",
        withoutPolicyDecision: "block",
        withPolicyDecision: "admit",
        criterionScopedPolicy: true,
        residualRisks: expect.arrayContaining([expect.any(String)]),
      },
      high: {
        resultValue: "asserted",
        decision: "escalate",
        stakesReference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        stakesValue: expect.any(Number),
        stakesComparison: expect.stringMatching(/^(at|above)$/),
      },
      silentlyPromotedToVerified: false,
    });
  });

  test("projects every source to its exact canonical origin", async () => {
    const receipt = await scenarioReceipt("all-origins");
    expect(receipt).toMatchObject({
      resultCode: "all_origins_admitted",
      canonicalOrigins: ["resident", "worker", "external_actor", "replay", "recovery"],
      sourceMappingsExact: true,
      allTraversedAdmissionBoundary: true,
    });
    expect(receipt.sourceReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundaryTraversed: true,
          terminalReceiptLinked: true,
        }),
      ]),
    );
    expect(
      parseArray(receipt.sourceReceipts).map((entry) => {
        const parsed = parseObject(entry);
        return { source: parsed.source, origin: parsed.origin };
      }),
    ).toEqual([
      { source: "resident", origin: "resident" },
      { source: "internal_worker", origin: "worker" },
      { source: "connector_worker", origin: "worker" },
      { source: "api", origin: "external_actor" },
      { source: "a2a", origin: "external_actor" },
      { source: "human", origin: "external_actor" },
      { source: "sdk:resident", origin: "resident" },
      { source: "sdk:worker", origin: "worker" },
      { source: "sdk:external_actor", origin: "external_actor" },
      { source: "internal:resident", origin: "resident" },
      { source: "internal:worker", origin: "worker" },
      { source: "internal:external_actor", origin: "external_actor" },
      { source: "replay", origin: "replay" },
      { source: "recovery", origin: "recovery" },
    ]);
  });

  test("fails the origin scenario when one source is misprojected", async () => {
    const receipt = await runAllOriginsCompletionAdmissionScenario((source) => {
      const parsed = WorkItemPublic.CompletionSourceOrigin.parse(source);
      return parsed.source === "api" ? "worker" : WorkItemPublic.projectCompletionOrigin(parsed);
    });

    expect(receipt).toMatchObject({
      ok: false,
      resultCode: "origin_admission_incomplete",
      sourceMappingsExact: false,
    });
  });

  test("returns typed stale_basis before admission or terminal append", async () => {
    expect(await scenarioReceipt("stale-basis")).toMatchObject({
      resultCode: "stale_basis_refused",
      errorCode: "stale_basis",
      admissionCount: 0,
      terminalAppendCount: 0,
      status: expect.not.stringMatching(/^completed$/),
    });
  });

  test("reopens filesystem SQLite and links the original admission", async () => {
    expect(await scenarioReceipt("restart-recovery")).toMatchObject({
      resultCode: "restart_recovery_linked",
      storage: "filesystem_sqlite",
      admissionRecordedBeforeRestart: true,
      storageReset: true,
      storageReopened: true,
      admissionId: expect.any(String),
      resumedAdmissionId: expect.any(String),
      reusedOriginalAdmissionId: true,
      terminalReceiptLinked: true,
      status: "completed",
      temporaryResourcesRemoved: true,
    });
  });

  test("proves the public store bypass refuses completion", async () => {
    expect(await scenarioReceipt("bypass-refusal")).toMatchObject({
      resultCode: "bypass_refused",
      errorCode: "admission_required",
      terminalMutation: false,
      admissionCount: 0,
      status: expect.not.stringMatching(/^completed$/),
    });
  });

  test("upcasts a legacy archive deterministically without rewriting its source", async () => {
    expect(await scenarioReceipt("legacy-archive")).toMatchObject({
      resultCode: "legacy_archive_upcast",
      sourceUnchanged: true,
      stableCriterionIds: true,
      stableAdmissionIds: true,
      stableReceiptIds: true,
      allClaimsPreserved: true,
      failedEvidencePreserved: true,
      allRequiredCriteriaEvidenced: true,
      archivedStatus: "completed",
      admissionCount: 1,
      terminalReceiptLinked: true,
      verifiedResultCount: 0,
      resultValues: ["asserted", "asserted"],
    });
  });

  test("self-test runs every scenario twice and compares deterministic receipts", async () => {
    const run = publicDriver();
    const first = await run(["--self-test"]);
    const second = await run(["--self-test"]);

    expect(first.exitCode).toBe(0);
    expect(second).toEqual(first);
    expect(parseObject(first.stdout)).toMatchObject({
      version: "completion-admission-driver-v1",
      mode: "self_test",
      ok: true,
      resultCode: "self_test_passed",
      scenarioRuns: 14,
      deterministic: true,
      scenarios: SCENARIOS.map((scenario) => ({
        scenario,
        runs: 2,
        deterministic: true,
      })),
    });
  });

  test("supports direct execution for help, invalid input, and self-test", async () => {
    const entry = new URL("../../src/work-item/completion-admission-driver.ts", import.meta.url)
      .pathname;
    const help = Bun.spawnSync([process.execPath, "run", entry, "--help"], {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const invalid = Bun.spawnSync([process.execPath, "run", entry, "--scenario", "unknown"], {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const selfTest = Bun.spawnSync([process.execPath, "run", entry, "--self-test"], {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString().trim()).toStartWith("Usage: completion-admission-driver");
    expect(invalid.exitCode).toBe(1);
    expect(parseObject(invalid.stdout.toString())).toMatchObject({
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    });
    expect(selfTest.exitCode).toBe(0);
    expect(selfTest.stderr.toString()).toBe("");
    expect(parseObject(selfTest.stdout.toString())).toMatchObject({
      mode: "self_test",
      ok: true,
      resultCode: "self_test_passed",
    });
  });
});

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}
