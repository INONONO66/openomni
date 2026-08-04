import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { createWorkerDispatchHandlers } from "../../../../packages/openomni/src/dispatch/handlers/worker";
import { createConnectorEndpointProcessDriver } from "../../src/connector/process-driver.js";

const tempRoots: string[] = [];

const CompletedConnectorDispatchOutput = z
  .object({
    output: z
      .object({
        result: z.object({
          status: z.literal("succeeded"),
          output: z.string(),
          error: z.string().optional(),
          finishReason: z.literal("exit_code:0"),
        }),
        reflection: z.object({
          workItemStatus: z.literal("completed"),
          completionBlocked: z.literal(false),
        }),
      })
      .passthrough(),
  })
  .passthrough();

const FailedConnectorDispatchOutput = z
  .object({
    output: z
      .object({
        result: z.object({
          status: z.literal("failed"),
          finishReason: z.literal("read_back_request_builder_failed"),
          error: z.string(),
        }),
        reflection: z.object({
          workItemStatus: z.literal("failed"),
          completionBlocked: z.literal(false),
        }),
      })
      .passthrough(),
  })
  .passthrough();

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const path = join(import.meta.dir, "..", ".tmp", name, crypto.randomUUID());
  mkdirSync(path, { recursive: true });
  tempRoots.push(path);
  return path;
}

function fakeConnector(command: string, args: readonly string[]): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake connector endpoint",
    detect: {
      command,
      testedVersions: ">=1.0.0 <2.0.0",
    },
    spawn: {
      command,
      args: [...args],
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
      timeoutMs: 1_000,
    },
    evidence: {
      emits: ["exit_code"],
      completionReport: { finalMessage: "stdout" },
    },
    requires: {},
    driver: {
      provider: "fake-cli",
      install: { scopes: ["workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["accepted", "completed"],
      emits: ["exit_code"],
    },
    profile: {
      kind: "connector_endpoint",
      taskTypes: ["code.change"],
    },
  };
}

function installation(definition: AppConnector.Definition): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: definition.id,
    connectorVersion: definition.version,
    endpointId: "endpoint:install:fake-cli",
    definition,
    testedVersions: definition.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function command(): Dispatch.Command {
  return {
    dispatchId: "dispatch-connector-endpoint",
    action: "worker.spawn",
    target: { kind: "worker", id: "app.fake-cli", endpointId: "endpoint:install:fake-cli" },
    payload: {
      prompt: "ship it",
      acceptanceCriteria: ["archived source contains the recorded quote exactly"],
    },
    actor: { kind: "user", actorId: "act_owner" },
    submittedAt: 1,
  };
}

describe("createConnectorEndpointProcessDriver completion stream", () => {
  test("keeps stdout completion JSON parseable when the connector process writes stderr diagnostics", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-completion-json");
    const scriptPath = join(workspaceRoot, "fake-cli.ts");
    writeFileSync(
      scriptPath,
      [
        "console.error('warning: non-fatal diagnostic');",
        "console.log(JSON.stringify({",
        "  completionReport: {",
        "    summary: 'Completed the delegated work.',",
        "    claims: [{ statement: 'Read-back passed.' }],",
        "  },",
        "  criterionFacts: [{",
        "    criterionIndex: 0,",
        "    evidenceRefs: [{ source: 'read_back', requestIndex: 0 }],",
        "    verification: { kind: 'archived_quote_match' },",
        "  }],",
        "  readBackRequests: [{",
        "    claimIndex: 0,",
        "    criterionIndex: 0,",
        "    request: {",
        "      kind: 'citation_match',",
        "      target: 'https://example.com/result',",
        "      quotedText: 'expected marker',",
        "    },",
        "  }],",
        "}));",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath, "{{prompt}}"]);
    const stored = AppConnectorInstallationStore.set(installation(definition));
    const handlers = createWorkerDispatchHandlers({
      connectorEndpointDriver: createConnectorEndpointProcessDriver(),
      readBackRecorder: (workItemHash, readBack) =>
        WorkItemStore.addReadBackEvidence(workItemHash, {
          kind: "citation_match",
          target: readBack.target,
          quotedText: readBack.kind === "citation_match" ? readBack.quotedText : "expected marker",
          matchedText: "expected marker",
          statusCode: 200,
          passed: true,
          observedAt: 1,
        }),
    });

    // When
    const result = CompletedConnectorDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, endpointId: stored.endpointId },
        workspaceRoot,
      }),
    );

    // Then
    expect(result.output.result.output).toContain('"completionReport"');
    expect(result.output.result.error).toBe("warning: non-fatal diagnostic");
    expect(result.output.reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
    expect(WorkItemStore.list()[0]?.completionReport?.claims[0]?.evidenceIds).toHaveLength(1);
  });

  test("adds connector-declared read-back requests to connector process completion envelopes", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-completion-readback-builder");
    const scriptPath = join(workspaceRoot, "fake-cli.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({",
        "  completionReport: {",
        "    summary: 'Published the requested page.',",
        "    claims: [{ statement: 'The published page contains the expected marker.' }],",
        "  },",
        "  criterionFacts: [{",
        "    criterionIndex: 0,",
        "    evidenceRefs: [{ source: 'read_back', requestIndex: 0 }],",
        "    verification: { kind: 'archived_quote_match' },",
        "  }],",
        "  deliverable: {",
        "    url: 'https://example.com/result',",
        "    marker: 'expected marker',",
        "  },",
        "}));",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath, "{{prompt}}"]),
      evidence: {
        emits: ["exit_code"],
        completionReport: {
          finalMessage: "stdout",
          readBackRequests: [
            {
              claimIndex: 0,
              criterionIndex: 0,
              request: {
                kind: "citation_match",
                target: "{{output.deliverable.url}}",
                quotedText: "{{output.deliverable.marker}}",
              },
            },
          ],
        },
      },
    } satisfies AppConnector.Definition;
    const stored = AppConnectorInstallationStore.set(installation(definition));
    const recordedReadBacks: unknown[] = [];
    const handlers = createWorkerDispatchHandlers({
      connectorEndpointDriver: createConnectorEndpointProcessDriver(),
      readBackRecorder: (workItemHash, readBack) => {
        recordedReadBacks.push(readBack);
        return WorkItemStore.addReadBackEvidence(workItemHash, {
          kind: "citation_match",
          target: readBack.target,
          quotedText: readBack.kind === "citation_match" ? readBack.quotedText : "expected marker",
          matchedText: "expected marker",
          statusCode: 200,
          passed: true,
          observedAt: 1,
        });
      },
    });

    // When
    const result = CompletedConnectorDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, endpointId: stored.endpointId },
        workspaceRoot,
      }),
    );

    // Then
    expect(recordedReadBacks).toEqual([
      {
        kind: "citation_match",
        target: "https://example.com/result",
        quotedText: "expected marker",
        timeoutMs: 10_000,
        maxBodyBytes: 1_000_000,
      },
    ]);
    expect(result.output.reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
    expect(WorkItemStore.list()[0]?.completionReport?.claims[0]?.evidenceIds).toHaveLength(1);
  });

  test("fails closed when connector read-back builders contain unsupported templates", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-completion-readback-builder-invalid");
    const scriptPath = join(workspaceRoot, "fake-cli.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({",
        "  completionReport: {",
        "    summary: 'Published the requested page.',",
        "    claims: [{ statement: 'The published page contains the expected marker.' }],",
        "  },",
        "  url: 'https://example.com/result',",
        "}));",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath, "{{prompt}}"]),
      evidence: {
        emits: ["exit_code"],
        completionReport: {
          finalMessage: "stdout",
          readBackRequests: [
            {
              claimIndex: 0,
              criterionIndex: 0,
              request: {
                kind: "citation_match",
                target: "{{output.url}}",
                quotedText: "{{unknown.marker}}",
              },
            },
          ],
        },
      },
    } satisfies AppConnector.Definition;
    const stored = AppConnectorInstallationStore.set(installation(definition));
    const handlers = createWorkerDispatchHandlers({
      connectorEndpointDriver: createConnectorEndpointProcessDriver(),
    });

    // When
    const result = FailedConnectorDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, endpointId: stored.endpointId },
        workspaceRoot,
      }),
    );

    // Then
    expect(result.output.result.error).toContain("unsupported template token");
    expect(WorkItemStore.list()[0]?.completionReport).toBeUndefined();
  });
});
