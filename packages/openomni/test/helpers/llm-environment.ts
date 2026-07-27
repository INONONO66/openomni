import type { ChatAgentConfig } from "@openomni/agent";
import { ModelsDev, type ModelCatalogService } from "@openomni/llm";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
  type SecretHandle,
} from "@openomni/llm/credential-runtime";
import { Execution } from "@openomni/protocol";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestLlmEnvironment {
  readonly sanitizer: BoundarySanitizer;
  readonly secrets: SecretRegistry;
  readonly credential: SecretHandle;
  readonly environment: ChatAgentConfig["environment"];
  readonly modelCatalog: ModelCatalogService;
}

export function createTestLlmEnvironment(): TestLlmEnvironment {
  const sanitizer = BoundarySanitizer.create();
  const secrets = SecretRegistry.create(sanitizer);
  const { handle: credential, ref } = secrets.register(
    CredentialSource.parseOwner({
      providerId: "test",
      credentialId: "test-credential",
      rotationId: "test-rotation",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: "test-api-key" },
    }),
  );
  const reference = Execution.LLMEnvironmentV1.parse({
    version: "llm-environment-v1",
    catalogSchemaVersion: 1,
    catalogSource: "bundled",
    catalogSourceVersion: "test",
    catalogDigest: "a".repeat(64),
    modelDigest: "b".repeat(64),
    endpoint: {
      version: "llm-endpoint-ref-v1",
      kind: "default",
      valueRef: "test-default",
      endpointDigest: "c".repeat(64),
    },
    credential: ref,
    sdkPackage: "@ai-sdk/openai",
    adapterVersion: "test",
    environmentDigest: "d".repeat(64),
  });
  const environment = Object.freeze({ reference, credential, secrets, sanitizer });
  const modelCatalog = ModelsDev.createService({
    cachePath: join(tmpdir(), `openomni-test-model-catalog-${crypto.randomUUID()}.json`),
    environment: reference,
    offline: true,
    fetchDisabled: true,
  });

  return Object.freeze({ sanitizer, secrets, credential, environment, modelCatalog });
}
