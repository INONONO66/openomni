import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
  type SecretHandle,
} from "@openomni/llm/credential-runtime";
import { AppConnector, type Dispatch, Execution } from "@openomni/protocol";
import { createWorkspaceIdentity, type ToolEffectLedgerPortV1 } from "@openomni/openomni";
import { createProductionComposition } from "../../src/bootstrap/kernel-services";
import { createConnectorEndpointProcessDriver } from "../../src/connector/process-driver";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): {
  readonly root: string;
  readonly identity: ReturnType<typeof createWorkspaceIdentity>;
} {
  const root = mkdtempSync(join(tmpdir(), "openomni-connector-credentials-"));
  roots.push(root);
  const identity = createWorkspaceIdentity(root);
  return { root: identity.canonicalRoot, identity };
}

function installation(input: {
  readonly command: string;
  readonly args?: readonly string[];
  readonly claim?: string;
  readonly consent?: readonly string[];
  readonly logs?: AppConnector.Logs;
  readonly driverProvider?: string;
}): AppConnector.Installation {
  const claim = input.claim ?? "OWNER_CONNECTOR_TOKEN";
  return AppConnector.Installation.parse({
    id: "installation-credentials",
    connectorId: "connector-credentials",
    connectorVersion: "1",
    endpointId: "endpoint-credentials",
    definition: {
      id: "connector-credentials",
      name: "Credential Connector",
      version: "1",
      description: "credential boundary test connector",
      detect: { command: input.command, testedVersions: "1" },
      spawn: { command: input.command, ...(input.args === undefined ? {} : { args: input.args }) },
      ...(input.logs === undefined ? {} : { logs: input.logs }),
      driver: {
        provider: input.driverProvider ?? "driver-provider",
        install: { scopes: ["workspace"] },
        submit: { mode: "spawn", ack: "running" },
        observedEvents: [],
        emits: [],
      },
      evidence: {
        emits: input.logs === undefined ? ["exit_code"] : ["exit_code", "artifact", "log_event"],
        ...(input.logs === undefined ? {} : { completionReport: { finalMessage: "log" } }),
      },
      requires: { credentials: [claim] },
      profile: { kind: "connector_endpoint", taskTypes: ["test"] },
    },
    testedVersions: "1",
    status: "enabled",
    registeredBy: "owner",
    consent: { grantedBy: "owner", grantedAt: 1, credentials: [...(input.consent ?? [claim])] },
    createdAt: 1,
    updatedAt: 1,
  });
}

function request(root: string): Execution.Request {
  return Execution.Request.parse({
    runId: "run-credentials",
    sessionId: "session-credentials",
    mode: "direct",
    prompt: "credential test",
    model: { provider: "test", id: "test" },
    workspaceRoot: root,
  });
}

function command(): Dispatch.Command {
  return {
    action: "worker.spawn",
    dispatchId: "dispatch-credentials",
    actor: { kind: "resident", actorId: "resident", sessionId: "session-credentials" },
    sessionId: "session-credentials",
    target: {
      kind: "worker",
      connectorInstallationId: "installation-credentials",
      endpointId: "endpoint-credentials",
    },
    submittedAt: 1,
  };
}

function acceptedEffects() {
  let intents = 0;
  const receipt = {
    version: "tool-effect-append-receipt-v1" as const,
    status: "accepted" as const,
  };
  const effects: ToolEffectLedgerPortV1 = {
    async appendIntent() {
      intents += 1;
      return receipt;
    },
    async appendSettlement() {
      return receipt;
    },
  };
  return { effects, intentCount: () => intents };
}

function ownerCredential(
  secret: string,
  providerId = "connector-secret-provider",
  credentialId = "OWNER_CONNECTOR_TOKEN",
) {
  const sanitizer = BoundarySanitizer.create();
  const registry = SecretRegistry.create(sanitizer);
  const loaded = registry.register(
    CredentialSource.parseOwner({
      providerId,
      credentialId,
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: secret },
    }),
  );
  return { registry, sanitizer, ...loaded };
}

function driver(input: {
  readonly root: string;
  readonly identity: ReturnType<typeof createWorkspaceIdentity>;
  readonly registry: SecretRegistry;
  readonly credentials?: Readonly<Record<string, SecretHandle>>;
  readonly artifacts?: string[];
  readonly effects: ToolEffectLedgerPortV1;
}) {
  return createConnectorEndpointProcessDriver({
    credentials: input.credentials,
    secretRegistry: input.registry,
    artifactWriter: {
      async putAndReference(artifact) {
        input.artifacts?.push(new TextDecoder().decode(artifact.content));
      },
    },
    effects: input.effects,
    workspaceIdentity: input.identity,
    kernelQueries: {
      async resolveInstallation() {
        return undefined;
      },
    },
    kernelTransitions: {} as never,
  });
}

async function dispatch(
  current: ReturnType<typeof driver>,
  root: string,
  connector: AppConnector.Installation,
): Promise<Execution.Result> {
  return current.dispatch({
    command: command(),
    executionRequest: request(root),
    installation: connector,
  });
}

describe.serial("connector process credential custody", () => {
  test("uses an exact consented claim and the handle provider while sanitizing all process egress", async () => {
    const { root, identity } = workspace();
    const secret = 'connector exact /+" canary';
    const encoded = Buffer.from(secret).toString("base64");
    const encodedUrl = encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    const escaped = JSON.stringify(secret).slice(1, -1);
    const credential = ownerCredential(secret);
    const effects = acceptedEffects();
    const artifacts: string[] = [];
    const script = [
      "const secret = process.env.OWNER_CONNECTOR_TOKEN;",
      "const base64 = Buffer.from(secret).toString('base64');",
      "const base64url = base64.replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');",
      "console.log(JSON.stringify({message:encodeURIComponent(secret),nested:{base64,base64url},ambient:Object.keys(process.env).sort()}));",
      "console.error(JSON.stringify(secret).slice(1,-1));",
    ].join("");
    const connector = installation({
      command: process.execPath,
      args: ["-e", script],
      logs: { kind: "jsonl", path: "stdout", eventTimeField: "time", messageField: "message" },
      driverProvider: "provider-that-does-not-own-the-secret",
    });

    try {
      const result = await dispatch(
        driver({
          root,
          identity,
          registry: credential.registry,
          credentials: { OWNER_CONNECTOR_TOKEN: credential.handle },
          artifacts,
          effects: effects.effects,
        }),
        root,
        connector,
      );
      const egress = JSON.stringify({ result, artifacts });
      expect(result.status).toBe("succeeded");
      expect(effects.intentCount()).toBe(1);
      expect(result.logEvents?.[0]?.data.ambient).not.toContain("HOME");
      for (const canary of [secret, escaped, encodeURIComponent(secret), encoded, encodedUrl]) {
        expect(egress).not.toContain(canary);
      }
      expect(egress).toContain("[REDACTED]");
    } finally {
      credential.registry.dispose();
    }
  });

  test("refuses missing and unconsented exact claims before recording an intent or spawning", async () => {
    const { root, identity } = workspace();
    const credential = ownerCredential("refusal-canary");
    try {
      for (const connector of [
        installation({
          command: process.execPath,
          args: ["-e", "throw new Error('spawned')"],
          consent: [],
        }),
        installation({
          command: process.execPath,
          args: ["-e", "throw new Error('spawned')"],
          claim: "MISSING",
        }),
      ]) {
        const effects = acceptedEffects();
        const result = await dispatch(
          driver({
            root,
            identity,
            registry: credential.registry,
            credentials: { OWNER_CONNECTOR_TOKEN: credential.handle },
            effects: effects.effects,
          }),
          root,
          connector,
        );
        expect(result.status).toBe("failed");
        expect(result.finishReason).toBe("credential_unavailable");
        expect(effects.intentCount()).toBe(0);
      }
    } finally {
      credential.registry.dispose();
    }
  });

  test("refuses handles from the wrong registry and forged claims before spawning", async () => {
    const { root, identity } = workspace();
    const owner = ownerCredential("owner-registry-canary");
    const wrong = ownerCredential("wrong-registry-canary");
    const forged = Object.freeze({
      providerId: "connector-secret-provider",
      credentialId: "OWNER_CONNECTOR_TOKEN",
    }) as unknown as SecretHandle;
    try {
      for (const handle of [owner.handle, forged]) {
        const effects = acceptedEffects();
        const result = await dispatch(
          driver({
            root,
            identity,
            registry: wrong.registry,
            credentials: { OWNER_CONNECTOR_TOKEN: handle },
            effects: effects.effects,
          }),
          root,
          installation({
            command: process.execPath,
            args: ["-e", "throw new Error('spawned')"],
          }),
        );
        expect(result).toMatchObject({ status: "failed", finishReason: "credential_unavailable" });
        expect(effects.intentCount()).toBe(0);
      }
    } finally {
      owner.registry.dispose();
      wrong.registry.dispose();
    }
  });

  test("redacts encoded secret material from spawn errors", async () => {
    const { root, identity } = workspace();
    const secret = "spawn-error-canary";
    const encoded = Buffer.from(secret).toString("base64");
    const credential = ownerCredential(secret);
    const effects = acceptedEffects();
    try {
      const result = await dispatch(
        driver({
          root,
          identity,
          registry: credential.registry,
          credentials: { OWNER_CONNECTOR_TOKEN: credential.handle },
          effects: effects.effects,
        }),
        root,
        installation({ command: join(root, encoded) }),
      );
      expect(result.status).toBe("failed");
      expect(result.error).not.toContain(encoded);
      expect(result.error).toContain("[REDACTED]");
    } finally {
      credential.registry.dispose();
    }
  });

  test("fails production startup on duplicate exact Owner credentialId claims", async () => {
    const { root } = workspace();
    const authPath = join(root, "auth.json");
    await Bun.write(
      authPath,
      `${JSON.stringify({
        anthropic: {
          providerId: "anthropic",
          credentialId: "DUPLICATE_CONNECTOR_CLAIM",
          rotationId: "rotation-1",
          sourceKind: "override_file",
          sourcePath: authPath,
          auth: { type: "api", key: "anthropic-secret" },
        },
        openai: {
          providerId: "openai",
          credentialId: "DUPLICATE_CONNECTOR_CLAIM",
          rotationId: "rotation-1",
          sourceKind: "override_file",
          sourcePath: authPath,
          auth: { type: "api", key: "openai-secret" },
        },
      })}\n`,
    );
    const previousAuthFile = process.env.OPENOMNI_AUTH_FILE;
    process.env.OPENOMNI_AUTH_FILE = authPath;
    try {
      const composition = createProductionComposition({
        workspace: { root },
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        mcp: { servers: [] },
        server: { port: 0, host: "127.0.0.1" },
        storage: { dbPath: join(root, "unused.db") },
        telegram: { allowedUsers: [] },
        github: { allowedUsers: [] },
        discord: { allowedUsers: [] },
      });
      await expect(composition.openRuntime(join(root, "production.db"))).rejects.toThrow(
        "Duplicate Owner connector credential claim: DUPLICATE_CONNECTOR_CLAIM",
      );
    } finally {
      if (previousAuthFile === undefined) delete process.env.OPENOMNI_AUTH_FILE;
      else process.env.OPENOMNI_AUTH_FILE = previousAuthFile;
    }
  });
});
