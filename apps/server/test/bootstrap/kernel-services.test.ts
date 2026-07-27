import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import type { ServerConfig } from "../../src/config";
import {
  createProductionModelCatalog,
  validateProductionConfig,
} from "../../src/bootstrap/kernel-services";

const cleanup: string[] = [];
const registries: SecretRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("createProductionModelCatalog", () => {
  test("binds proxy Owner credentials to a proxy environment endpoint", async () => {
    const sanitizer = BoundarySanitizer.create();
    const secrets = SecretRegistry.create(sanitizer);
    registries.push(secrets);
    const registered = secrets.register(
      CredentialSource.parseOwner({
        providerId: "openai",
        credentialId: "proxy-owner",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: { type: "proxy", baseURL: "https://proxy.invalid/v1", apiKey: "proxy-key" },
      }),
    );
    const root = mkdtempSync(join(tmpdir(), "openomni-kernel-services-"));
    cleanup.push(root);
    const config = validateProductionConfig({
      model: { provider: "openai", id: "gpt-4o" },
      workspace: { root },
    } as ServerConfig);

    const loaded = await createProductionModelCatalog(config, join(root, "ledger.sqlite"), [
      registered,
    ]).load();

    expect(loaded.environment.credential.endpointRef).toBe("proxy:https://proxy.invalid/v1");
    expect(loaded.environment.endpoint).toEqual({
      version: "llm-endpoint-ref-v1",
      kind: "proxy",
      valueRef: "proxy:https://proxy.invalid/v1",
      endpointDigest: createHash("sha256").update("https://proxy.invalid/v1").digest("hex"),
    });
  });
});
