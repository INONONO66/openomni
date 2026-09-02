import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectIpcClient, type IpcClient, typedCall } from "@openomni/ipc";
import { initialize, Storage, WorkItemStore } from "@openomni/ledger";
import {
  attachMachineDaemon,
  createMachineHost,
  type MachineDaemon,
  type MachineHost,
  type SandboxProfile,
} from "@openomni/machines";
import { type Delegation, Machine, WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createCommandVerifier } from "../src/delegation/command-verifier";
import { createDelegationKernel, type DelegationKernel } from "../src/delegation/kernel";
import { createVerificationCoordinator } from "../src/delegation/verification";
import { createWorkItemLinkage } from "../src/delegation/work-item-linkage";
import { createCompletionPort } from "../src/work-item/completion";
import { validateCompletionTerminalLinkage } from "../src/work-item/terminal-linkage";
import { socketPath as testSocketPath } from "./helpers/socket-path";

const MACHINE_ID = "verifier-machine";
const SESSION_ID = "verification-owner";
const resources: Array<{ close(): void }> = [];
const kernels: DelegationKernel[] = [];
const directories: string[] = [];

const enrollment: Machine.Enrollment = {
  machineId: MACHINE_ID,
  name: "verification machine",
  allowedCapabilities: ["kernel.py", "sandbox.process"],
  enrolledAt: 0,
};

const sandboxProfile = (workspaceRoot: string): SandboxProfile => ({
  backend: "bubblewrap",
  bwrapPath: "/usr/bin/bwrap",
  pythonPath: "/usr/bin/python3",
  workspaceRoot,
  readOnlyPaths: ["/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache", "/etc/alternatives"],
  maxOutputBytes: 1_048_576,
});

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.stop();
  for (const resource of resources.splice(0).reverse()) resource.close();
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type VerifierMachine = Readonly<{
  host: Pick<MachineHost, "runCell">;
  machineFor: () => Machine.MachineId | undefined;
  executables: ReadonlyMap<string, string>;
}>;

async function verifiedDelegation(
  machine: VerifierMachine,
  declaration: Delegation.VerificationDeclaration,
) {
  const completionWriter = initialize({
    dbPath: join(tempDirectory("openomni-verification-e2e-"), "ledger.db"),
  });
  const workItems = createWorkItemLinkage({
    model: { provider: "test", id: "test" },
    now: () => Date.now(),
  });
  const verifier = createCommandVerifier({
    runCell: (machineId, request) => machine.host.runCell(machineId, request),
    machineFor: machine.machineFor,
    executables: machine.executables,
    newCellId: () => crypto.randomUUID(),
    maxOutputBytes: 1_048_576,
  });
  const kernel = createDelegationKernel({
    drivers: {
      process: {
        run: () => Promise.resolve({ status: "completed", output: "worker reports done" }),
      },
    },
    now: () => Date.now(),
    newDelegationId: () => crypto.randomUUID(),
    wake: () => undefined,
    workItems,
    verification: createVerificationCoordinator({ verifier, now: () => Date.now() }),
  });
  kernels.push(kernel);
  let finishAttempt: ((workItemId: string) => void) | undefined;
  const attemptClosed = new Promise<string>((resolve) => {
    finishAttempt = resolve;
  });
  const unsubscribe = Bus.subscribe(WorkItem.Events.Updated, (event) => {
    if (event.payload.fields.includes("attemptTerminal")) {
      unsubscribe();
      finishAttempt?.(event.payload.workItemId);
    }
  });
  const delegated = await kernel.delegate(
    {
      operation: "assign",
      address: { kind: "core", scope: "independent" },
      payload: { text: "perform checkable work" },
      acceptanceCriteria: ["registered command exits as declared"],
      verification: declaration,
      deadline: Date.now() + 20_000,
    },
    { role: "resident", depth: 0, sessionId: SESSION_ID },
  );
  if (!("handle" in delegated)) throw delegated.error;
  const awaited = await kernel.awaitDelegation(delegated.handle.delegationId, 15_000);
  if (awaited.kind !== "settled") throw new Error("verification delegation did not settle");
  const workItemId = await attemptClosed;
  const item = WorkItemStore.get(workItemId);
  if (item === undefined) throw new Error("verification WorkItem disappeared");
  return {
    settlement: awaited.settlement,
    item,
    completion: createCompletionPort({ writer: completionWriter, now: () => Date.now() }),
  };
}

test("isolation refusal records a verification error and can never settle verified", async () => {
  // Given: a real host attachment offers kernel.py but not sandbox.process.
  const socketPath = testSocketPath();
  const host = await createMachineHost({
    socketPath,
    enrollment: (machineId) => (machineId === MACHINE_ID ? enrollment : undefined),
    events: Bus,
    now: () => Date.now(),
  });
  resources.push(host);
  const client: IpcClient = await connectIpcClient(socketPath, {});
  resources.push(client);
  await typedCall(client, Machine.WireMethod.Attach, {
    machineId: MACHINE_ID,
    offeredCapabilities: [Machine.WellKnownCapability.pythonKernel],
    daemonVersion: "test",
    platform: process.platform,
    offeredAt: 0,
  });

  // When: command.v1 traverses the real host isolation gate after the worker report.
  const outcome = await verifiedDelegation(
    {
      host,
      machineFor: () => MACHINE_ID,
      executables: new Map([["true", "/usr/bin/true"]]),
    },
    {
      kind: "command.v1",
      executable: { id: "true" },
      argv: [],
      timeoutMs: 1000,
      expectations: [{ criterionIndex: 0, exitCode: 0 }],
    },
  );

  // Then: the refusal is durable and the terminal is explicitly unverified.
  expect(outcome.settlement).toMatchObject({ status: "unverified", reason: "verification_error" });
  expect(outcome.item.completionFacts.verificationErrors).toMatchObject([
    { code: "prohibited_capability", detail: "isolation_unavailable" },
  ]);
  expect(outcome.item.completionFacts.results).toEqual([]);
}, 30_000);

const sandboxTestsRequired = process.env.OPENOMNI_REQUIRE_SANDBOX_TESTS === "1";
const bubblewrapAvailable = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const linuxSandboxTest = test.skipIf(!sandboxTestsRequired && !bubblewrapAvailable);

linuxSandboxTest(
  "a sandboxed registered command records verified facts consumed by completion admission",
  async () => {
    if (!bubblewrapAvailable) {
      throw new Error(
        "OPENOMNI_REQUIRE_SANDBOX_TESTS=1 requires Linux with /usr/bin/bwrap installed",
      );
    }

    // Given: the real bubblewrap daemon attached with both execution capabilities.
    const socketPath = testSocketPath();
    const host = await createMachineHost({
      socketPath,
      enrollment: (machineId) => (machineId === MACHINE_ID ? enrollment : undefined),
      events: Bus,
      now: () => Date.now(),
    });
    resources.push(host);
    const daemon: MachineDaemon = await attachMachineDaemon({
      socketPath,
      offer: {
        machineId: MACHINE_ID,
        offeredCapabilities: [Machine.WellKnownCapability.pythonKernel],
        daemonVersion: "test",
        platform: "linux",
        offeredAt: 0,
      },
      sandbox: sandboxProfile(tempDirectory("openomni-verifier-sandbox-")),
    });
    resources.push(daemon);

    // When: /usr/bin/true verifies the criterion, then completion selects its durable result.
    const outcome = await verifiedDelegation(
      {
        host,
        machineFor: () =>
          host.attached(MACHINE_ID)?.includes(Machine.WellKnownCapability.sandboxProcess)
            ? MACHINE_ID
            : undefined,
        executables: new Map([["true", "/usr/bin/true"]]),
      },
      {
        kind: "command.v1",
        executable: { id: "true" },
        argv: [],
        timeoutMs: 1000,
        expectations: [{ criterionIndex: 0, exitCode: 0 }],
      },
    );
    const result = outcome.item.completionFacts.results[0];
    if (result === undefined) throw new Error("verified result was not recorded");
    const completed = await outcome.completion.complete({
      workItemId: outcome.item.workItemId,
      judgments: [{ criterionId: result.criterionId, value: "recorded", resultId: result.id }],
    });

    // Then: recorded facts are the only input to the existing completion admission/receipt path.
    expect(outcome.settlement).toMatchObject({ status: "verified", factIds: [result.id] });
    expect(completed).toEqual({ admitted: true, workItemId: outcome.item.workItemId });
    const item = WorkItemStore.get(outcome.item.workItemId);
    expect(item?.completionFacts.admissions.at(-1)?.effectiveResultIds).toEqual([result.id]);
    expect(item === undefined ? false : validateCompletionTerminalLinkage(item).success).toBe(true);
  },
  60_000,
);
