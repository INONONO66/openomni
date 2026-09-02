import { expect, test } from "bun:test";
import type { Machine } from "@openomni/protocol";
import { createCommandVerifier } from "../src/delegation/command-verifier";
import type { CellPorts } from "../src/tools/run-code";

const EXITED = {
  status: "exited" as const,
  exitCode: 0,
  stdoutSha256: "a".repeat(64),
  stderrSha256: "b".repeat(64),
  stdoutBytes: 5,
  stderrBytes: 0,
  truncated: false,
  durationMs: 12,
};

function verifierWith(runCell: CellPorts["runCell"], machineId: string | null = "alpha") {
  return createCommandVerifier({
    runCell,
    machineFor: () => machineId ?? undefined,
    executables: new Map([["build", "/usr/bin/true"]]),
    newCellId: () => "verifier-cell-1",
    maxOutputBytes: 1024,
  });
}

test("a registered command runs through a tenant-bound machine cell", async () => {
  // Given: a registered executable and a machine cell returning bounded command metadata.
  let dispatched:
    | Readonly<{ machineId: Machine.MachineId; request: Machine.CellRequest }>
    | undefined;
  const verifier = verifierWith(async (machineId, request) => {
    dispatched = { machineId, request };
    return {
      status: "completed",
      cellId: request.cellId,
      output: { stdout: `${JSON.stringify(EXITED)}\n`, stderr: "" },
    };
  });

  // When: the coordinator-facing port invokes the registered id.
  const result = await verifier.run({
    executableId: "build",
    argv: ["--flag", "literal; never a shell"],
    timeoutMs: 250,
    tenant: "owner-session",
  });

  // Then: only metadata returns and the cell retains the caller's tenant/deadline.
  expect(result).toEqual(EXITED);
  expect(dispatched).toMatchObject({
    machineId: "alpha",
    request: { cellId: "verifier-cell-1", tenant: "owner-session", timeoutMs: 1250 },
  });
});

test("an unregistered executable is refused before any machine call", async () => {
  // Given: a verifier with one different Owner-registered executable.
  let calls = 0;
  const verifier = verifierWith(async () => {
    calls += 1;
    return { status: "timed_out", cellId: "unused" };
  });

  // When: a declaration names an id outside that registry.
  const result = await verifier.run({
    executableId: "unknown",
    argv: [],
    timeoutMs: 250,
    tenant: "owner-session",
  });

  // Then: the boundary refuses without dispatching attacker-selected text.
  expect(result).toEqual({ status: "refused", reason: "executable_unregistered" });
  expect(calls).toBe(0);
});

test("a verifier without an eligible attached machine refuses before execution", async () => {
  // Given: the executable exists but no attached machine is eligible.
  let calls = 0;
  const verifier = verifierWith(async () => {
    calls += 1;
    return { status: "timed_out", cellId: "unused" };
  }, null);

  // When: the registered command is requested.
  const result = await verifier.run({
    executableId: "build",
    argv: [],
    timeoutMs: 250,
    tenant: "owner-session",
  });

  // Then: no cell runs and the coordinator receives a typed refusal.
  expect(result).toEqual({ status: "refused", reason: "machine_not_attached" });
  expect(calls).toBe(0);
});

test.each([
  {
    name: "a kernel-only machine",
    cell: { status: "refused" as const, reason: "kernel_not_available" as const },
    result: { status: "refused", reason: "isolation_unavailable" },
  },
  {
    name: "an isolation refusal",
    cell: { status: "refused" as const, reason: "isolation_unavailable" as const },
    result: { status: "refused", reason: "isolation_unavailable" },
  },
  {
    name: "a detached machine",
    cell: { status: "refused" as const, reason: "machine_not_attached" as const },
    result: { status: "refused", reason: "machine_not_attached" },
  },
  {
    name: "an outer cell deadline",
    cell: { status: "timed_out" as const, cellId: "verifier-cell-1" },
    result: { status: "timed_out", durationMs: 250 },
  },
])("maps $name into a coordinator command result", async ({ cell, result }) => {
  // Given: the machine boundary returns one typed non-success outcome.
  const verifier = verifierWith(() => Promise.resolve(cell));

  // When: the registered command traverses the port.
  const actual = await verifier.run({
    executableId: "build",
    argv: [],
    timeoutMs: 250,
    tenant: "owner-session",
  });

  // Then: no outcome can be mistaken for an exited command.
  expect(actual).toEqual(result);
});

test.each([
  {
    name: "a raised verifier cell",
    cell: {
      status: "raised" as const,
      cellId: "verifier-cell-1",
      output: { stdout: "", stderr: "" },
      error: "subprocess failed",
    },
  },
  {
    name: "malformed verifier metadata",
    cell: {
      status: "completed" as const,
      cellId: "verifier-cell-1",
      output: { stdout: "not json", stderr: "" },
    },
  },
])("throws on $name so the coordinator records verifier_crash", async ({ cell }) => {
  // Given: the trusted machine channel cannot produce valid command metadata.
  const verifier = verifierWith(() => Promise.resolve(cell));

  // When/Then: the port throws instead of inventing an execution result.
  await expect(
    verifier.run({
      executableId: "build",
      argv: [],
      timeoutMs: 250,
      tenant: "owner-session",
    }),
  ).rejects.toBeInstanceOf(Error);
});
