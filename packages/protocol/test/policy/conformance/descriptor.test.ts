import { describe, expect, test } from "bun:test";
import { RuntimeResource } from "../../../src/policy/index.js";

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function digestDescriptor(descriptor: RuntimeResource.Descriptor): string {
  const { digest: _digest, ...content } = descriptor;
  let hash = 0x811c9dc5;

  for (const char of canonicalize(content)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function withDigest(descriptor: RuntimeResource.Descriptor): RuntimeResource.Descriptor {
  return RuntimeResource.Descriptor.parse({
    ...descriptor,
    digest: digestDescriptor(descriptor),
  });
}

function redactDescriptor(descriptor: RuntimeResource.Descriptor): RuntimeResource.Descriptor {
  if (descriptor.source?.type !== "file") return descriptor;

  return RuntimeResource.Descriptor.parse({
    ...descriptor,
    source: {
      ...descriptor.source,
      ...(descriptor.source.path === undefined ? {} : { path: "[REDACTED]" }),
      ...(descriptor.source.filePath === undefined ? {} : { filePath: "[REDACTED]" }),
    },
  });
}

function serializeForAudit(descriptor: RuntimeResource.Descriptor): string {
  return JSON.stringify(redactDescriptor(descriptor));
}

const descriptorFixtures: RuntimeResource.Descriptor[] = [
  RuntimeResource.Descriptor.parse({
    id: "tool:system:bash",
    kind: "tool",
    labels: ["source.system", "tool.shell"],
    capabilities: ["shell.exec"],
    effects: ["workspace.mutate"],
    source: { type: "system" },
    risk: 3,
  }),
  RuntimeResource.Descriptor.parse({
    id: "tool:mcp:filesystem-read",
    kind: "tool",
    labels: ["source.mcp", "mcp.filesystem"],
    capabilities: ["file.read"],
    effects: ["workspace.read"],
    source: { type: "mcp", serverId: "filesystem", remoteName: "read_file" },
  }),
  RuntimeResource.Descriptor.parse({
    id: "tool:skill-mcp:publish",
    kind: "tool",
    labels: ["source.skill-mcp", "skill.github-workflow"],
    capabilities: ["github.write"],
    effects: ["network.write"],
    source: {
      type: "skill-mcp",
      serverId: "github",
      remoteName: "create_pull_request",
      skillId: "github-workflow",
    },
  }),
  RuntimeResource.Descriptor.parse({
    id: "tool:agent:delegate",
    kind: "tool",
    labels: ["source.agent", "delegation.worker"],
    capabilities: ["worker.spawn"],
    effects: ["session.create"],
    source: { type: "agent", agentId: "main-persona", agentProfileRef: "agent-profile:main" },
  }),
  RuntimeResource.Descriptor.parse({
    id: "tool:server:telegram-send",
    kind: "tool",
    labels: ["source.server", "surface.telegram"],
    capabilities: ["message.send"],
    effects: ["network.write"],
    source: { type: "server", serverId: "server-main", remoteName: "telegram.send" },
  }),
  RuntimeResource.Descriptor.parse({
    id: "skill:project:git-master",
    kind: "skill",
    labels: ["source.project", "skill.git"],
    capabilities: ["behavior.inject"],
    effects: ["prompt.modify"],
    source: { type: "project", projectId: "openomni", path: ".opencode/skill/git-master" },
  }),
  RuntimeResource.Descriptor.parse({
    id: "mcpSource:server:filesystem",
    kind: "mcpSource",
    labels: ["source.server", "mcp.filesystem"],
    capabilities: ["tool.catalog"],
    effects: ["tool.expose"],
    source: { type: "server", serverId: "filesystem" },
  }),
  RuntimeResource.createWorkerDescriptor("worker-1", { source: "coordinator-main" }),
  RuntimeResource.createCredentialDescriptor("anthropic", "api-key", {
    source: "/var/openomni/secrets/anthropic.json",
  }),
  RuntimeResource.createSessionDescriptor("ses_child", "self-loop", {
    parentSessionId: "ses_root",
    ownerActorId: "agent:main-persona",
  }),
  RuntimeResource.Descriptor.parse({
    id: "policy:operator:default",
    kind: "policy",
    labels: ["source.user", "policy.default"],
    capabilities: ["policy.evaluate"],
    effects: ["runtime.govern"],
    source: { type: "user", userId: "operator" },
  }),
];

function firstFixture(): RuntimeResource.Descriptor {
  const [descriptor] = descriptorFixtures;
  if (descriptor === undefined) throw new Error("descriptor fixture missing");
  return descriptor;
}

describe("RuntimeResource.Descriptor conformance", () => {
  test("roundtrip serializes and validates every descriptor kind", () => {
    for (const descriptor of descriptorFixtures) {
      const parsed = RuntimeResource.Descriptor.parse(descriptor);
      const serialized = JSON.stringify(parsed);
      const restored = RuntimeResource.Descriptor.parse(JSON.parse(serialized));

      expect(restored).toEqual(parsed);
    }
  });

  test("digest is stable for the same content and changes with descriptor content", () => {
    const base = firstFixture();
    const sameContent = withDigest(RuntimeResource.Descriptor.parse({ ...base }));
    const repeated = withDigest(RuntimeResource.Descriptor.parse({ ...base }));
    const changedContent = withDigest(
      RuntimeResource.Descriptor.parse({
        ...base,
        labels: [...base.labels, "risk.shell"],
      }),
    );

    expect(sameContent.digest).toBe(repeated.digest);
    expect(changedContent.digest).not.toBe(sameContent.digest);
    expect(RuntimeResource.Descriptor.parse(sameContent).digest).toBe(sameContent.digest);
  });

  test("redact removes credential source paths from serialized descriptors", () => {
    const secretPath = "/var/openomni/secrets/anthropic.json";
    const credential = RuntimeResource.createCredentialDescriptor("anthropic", "api-key", {
      source: secretPath,
    });
    const serialized = serializeForAudit(credential);

    expect(serialized.includes("[REDACTED]")).toBe(true);
    expect(serialized.includes(secretPath)).toBe(false);
    expect(RuntimeResource.Descriptor.parse(JSON.parse(serialized)).source).toMatchObject({
      type: "file",
      path: "[REDACTED]",
    });
  });
});
