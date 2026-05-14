import { describe, expect, test } from "bun:test";
import { RuntimeResource } from "../../src/policy/index.js";

describe("RuntimeResource descriptor helpers", () => {
  test("creates a worker descriptor", () => {
    const descriptor = RuntimeResource.createWorkerDescriptor("w-123", {
      source: "worker-1",
    });

    expect(descriptor).toMatchObject({
      id: "worker:coordinator:w-123",
      kind: "worker",
      source: {
        type: "coordinator",
        coordinatorId: "worker-1",
      },
    });
    expect(RuntimeResource.Descriptor.parse(descriptor)).toEqual(descriptor);
  });

  test("creates a credential descriptor", () => {
    const descriptor = RuntimeResource.createCredentialDescriptor("anthropic", "api-key", {
      source: "/var/openomni/secrets.json",
    });

    expect(descriptor).toMatchObject({
      id: "credential:anthropic:api-key",
      kind: "credential",
      source: {
        type: "file",
        path: "/var/openomni/secrets.json",
      },
    });
    expect(RuntimeResource.Descriptor.parse(descriptor)).toEqual(descriptor);
  });

  test("creates a session descriptor", () => {
    const descriptor = RuntimeResource.createSessionDescriptor("ses_abc", "child", {
      parentSessionId: "ses_parent",
      ownerActorId: "agent:main-persona",
    });

    expect(descriptor).toMatchObject({
      id: "session:ses_abc",
      kind: "session",
      owner: "agent:main-persona",
      source: {
        type: "runtime",
        runtimeId: "ses_abc",
      },
      labels: ["source.runtime", "session.child", "session.parent:ses_parent"],
    });
    expect(RuntimeResource.Descriptor.parse(descriptor)).toEqual(descriptor);
  });
});
