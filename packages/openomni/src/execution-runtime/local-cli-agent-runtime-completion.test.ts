import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { createWorkerDispatchHandlers } from "../dispatch/handlers/worker";
import { createLocalCliAgentRuntime } from "./local-cli-agent-runtime.js";

const tempRoots: string[] = [];

const CompletedLocalCliDispatchOutput = z
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

const FailedLocalCliDispatchOutput = z
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
  const path = join(import.meta.dir, "..", "..", "test", ".tmp", name, crypto.randomUUID());
  mkdirSync(path, { recursive: true });
  tempRoots.push(path);
  return path;
}

function fakeConnector(command: string, args: readonly string[]): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake local CLI agent",
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
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
    },
  };
}

function installation(definition: AppConnector.Definition): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: definition.id,
    connectorVersion: definition.version,
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
    dispatchId: "dispatch-local-cli",
    action: "worker.spawn",
    target: { kind: "worker", id: "app.fake-cli", executorKind: "local_cli_agent" },
    payload: { prompt: "ship it", acceptanceCriteria: ["done"] },
    actor: { kind: "user", actorId: "act_owner" },
    submittedAt: 1,
  };
}

describe("createLocalCliAgentRuntime completion stream", () => {
  test("keeps stdout completion JSON parseable when the local CLI writes stderr diagnostics", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-completion-json");
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
        "  readBackRequests: [{",
        "    claimIndex: 0,",
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
      localCliAgentRuntime: createLocalCliAgentRuntime(),
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
    const result = CompletedLocalCliDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, executorKind: "local_cli_agent" },
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

  test("adds connector-declared read-back requests to local CLI completion envelopes", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-completion-readback-builder");
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
        "  marker: 'expected marker',",
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
              request: {
                kind: "citation_match",
                target: "{{output.url}}",
                quotedText: "{{output.marker}}",
              },
            },
          ],
        },
      },
    } satisfies AppConnector.Definition;
    const stored = AppConnectorInstallationStore.set(installation(definition));
    const recordedReadBacks: unknown[] = [];
    const handlers = createWorkerDispatchHandlers({
      localCliAgentRuntime: createLocalCliAgentRuntime(),
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
    const result = CompletedLocalCliDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, executorKind: "local_cli_agent" },
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
    const workspaceRoot = tempDir("local-cli-runtime-completion-readback-builder-invalid");
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
      localCliAgentRuntime: createLocalCliAgentRuntime(),
    });

    // When
    const result = FailedLocalCliDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, executorKind: "local_cli_agent" },
        workspaceRoot,
      }),
    );

    // Then
    expect(result.output.result.error).toContain("unsupported template token");
    expect(WorkItemStore.list()[0]?.completionReport).toBeUndefined();
  });
});
