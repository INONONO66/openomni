import { type BusEvent, Ipc } from "@openomni/protocol";
import type { WorkerPorts } from "../../src/worker-manager";

export type CollectedEvent = { event: BusEvent.Descriptor<unknown>; data: unknown };

/**
 * Test binding for the driver's ports (#462 §2): events go to an in-memory
 * collector instead of the ledger Bus.
 */
export function collectorPorts(): WorkerPorts & { collected: CollectedEvent[] } {
  const collected: CollectedEvent[] = [];
  const digest = "a".repeat(64);
  return {
    collected,
    events: {
      publish(event, data) {
        collected.push({ event: event as BusEvent.Descriptor<unknown>, data });
      },
    },
    runtimeDefinition: async (binding) =>
      Ipc.WorkerRuntimeDefinitionV1.parse({
        runtimeId: binding.runtimeId,
        workerId: binding.workerId,
        generation: binding.generation,
        principalId: binding.principalId,
        attempt: {
          version: "attempt-ref-v1",
          workItemId: "work-fixture",
          attemptId: "attempt-fixture",
          attemptSeq: 1,
        },
        config: {
          configEpoch: "fixture",
          model: { provider: "anthropic", id: "fixture-model" },
          environment: {
            version: "llm-environment-v1",
            catalogSchemaVersion: 1,
            catalogSource: "bundled",
            catalogSourceVersion: "fixture",
            catalogDigest: digest,
            modelDigest: digest,
            endpoint: {
              version: "llm-endpoint-ref-v1",
              kind: "default",
              valueRef: "provider-default",
              endpointDigest: digest,
            },
            credential: {
              version: "credential-source-ref-v1",
              providerId: "anthropic",
              authType: "api",
              credentialId: "fixture",
              rotationId: "fixture",
              sourceKind: "injected_runtime",
              sourcePathDigest: digest,
              credentialDigest: digest,
            },
            sdkPackage: "@ai-sdk/anthropic",
            adapterVersion: "fixture",
            environmentDigest: digest,
          },
          workspace: {
            canonicalizerVersion: "workspace-v1",
            workspaceId: `w1:${digest}`,
            canonicalBytesDigest: digest,
          },
          agents: [],
          toolCatalog: [{ name: "fixture.tool", inputSchema: { type: "object" } }],
        },
      }),
    kernelTransition: async () => ({
      version: "kernel-transition-result-v1",
      status: "rejected",
      code: "transition_forbidden",
    }),
    kernelQuery: async () => ({
      version: "kernel-query-result-v1",
      kind: "authenticated_transcript",
      messages: [],
    }),
    observation: async () => undefined,
    provisionCredentials: async (frame, _signer) => ({
      privateFrame: new Uint8Array([1]),
      receipt: {
        version: "credential-provisioning-receipt-v1",
        runtimeId: frame.request.runtimeId,
        workerId: frame.request.workerId,
        generation: frame.request.generation,
        principalId: frame.request.principalId,
        attempt: frame.request.attempt,
        nonceRef: frame.request.nonceRef,
        acceptedCredentialDigests: frame.request.credentialRefs.map(
          (credential) => credential.credentialDigest,
        ),
        acceptedAtDbMs: Date.now(),
      },
      acknowledge: async () => undefined,
    }),
  };
}
