import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelInstanceStore, PersonStore, SecretStore, Storage, Vault } from "@openomni/ledger";
import { type PlainObject, Provisioning } from "@openomni/protocol";
import type { ChannelRuntimeStatus } from "../src/provisioning/supervisor";
import { createTools } from "../src/tools/core/catalog";
import { createDispatcher, eraseTool } from "@openomni/agent";
import { createProvisionTool, type ProvisionPort } from "../src/tools/provision";
import { executor } from "./helpers/executor";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

const NOW = 1_756_000_000_000;
const RESIDENT = { role: "resident", depth: 0, sessionId: "provision-test" } as const;

const provisionTool = (name: string, port: ProvisionPort, now: () => number = Date.now) => {
  const run = modelToolOutput("provision", { provisioning: port }, RESIDENT, now);
  const op = name === "provision_status" ? "status" : name;
  return (input: PlainObject) => run({ operation: { op, args: input } });
};
const personDeclare = (port: ProvisionPort, now?: () => number) =>
  provisionTool("contact_add", port, now);
const personRemove = (port: ProvisionPort) => provisionTool("contact_remove", port);
const channelDeclare = (port: ProvisionPort, now?: () => number) =>
  provisionTool("channel_add", port, now);
const channelEnable = (port: ProvisionPort, now?: () => number) =>
  provisionTool("channel_enable", port, now);
const channelDisable = (port: ProvisionPort, now?: () => number) =>
  provisionTool("channel_disable", port, now);
const secretRotate = (port: ProvisionPort, now?: () => number) =>
  provisionTool("secret_rotate", port, now);
const provisionStatus = (port: ProvisionPort) => provisionTool("provision_status", port);
const KEK = Vault.kekOf(new Uint8Array(32).fill(7));

interface FakeSupervisor {
  readonly calls: string[];
  statuses: ChannelRuntimeStatus[];
}

function portWith(overrides: Partial<ProvisionPort> = {}): {
  port: ProvisionPort;
  supervisor: FakeSupervisor;
} {
  const supervisor: FakeSupervisor = { calls: [], statuses: [] };
  const port: ProvisionPort = {
    persons: PersonStore,
    instances: ChannelInstanceStore,
    secrets: SecretStore,
    kek: { kind: "ok", kek: KEK },
    supervisor: {
      reconcile: async () => {
        supervisor.calls.push("reconcile");
        return supervisor.statuses;
      },
      resume: (instanceId) => {
        supervisor.calls.push(`resume:${instanceId}`);
        return true;
      },
      status: () => supervisor.statuses,
      source: () => "declared",
    },
    materialize: () => {
      supervisor.calls.push("materialize");
    },
    removeIdentity: (id) => {
      supervisor.calls.push(`removeIdentity:${id}`);
      return true;
    },
    ...overrides,
  };
  return { port, supervisor };
}

const MANAGER_MANIFEST = {
  id: "person:sunwoo",
  kind: "human" as const,
  trustTier: "manager" as const,
  endpoints: [{ channel: "telegram", externalId: "555" }],
};

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("provision output boundary", () => {
  test("rejects malformed output through the dispatcher", async () => {
    const { port } = portWith();
    const tool = eraseTool(createProvisionTool(port));
    const result = await createDispatcher([{ ...tool, execute: async () => ({ op: "status" }) }], {
      executor,
    }).execute(
      {
        id: "provision-invalid-output",
        tool: "provision",
        input: { operation: { op: "status", args: {} } },
      },
      { sessionId: "provision-session", turnId: "provision-turn" },
    );

    expect(result).toEqual({
      toolCallId: "provision-invalid-output",
      id: "provision-invalid-output",
      toolName: "provision",
      output: "provision produced invalid output",
      isError: true,
      errorKind: "invalid_output",
    });
  });
});

/** Open the Owner-consent request for declaring one manifest through the protected dispatcher. */
function consentedDeclare(port: ProvisionPort, manifest: PlainObject) {
  return protectedDispatch(eraseTool(createProvisionTool(port)), {
    operation: { op: "contact_add", args: { manifest } },
  });
}

describe("original Person invocation consent", () => {
  test("a protected raise suspends then applies the exact original manifest once", async () => {
    const { port, supervisor } = portWith();
    const f = consentedDeclare(port, MANAGER_MANIFEST);
    try {
      const request = await bounded(f.opened);
      expect(request.parsedInput).toEqual({
        operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST } },
      });
      expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
      expect(supervisor.calls).toEqual([]);
      expect((await f.answer()).isError).toBeUndefined();
      expect(PersonStore.get(MANAGER_MANIFEST.id)?.trustTier).toBe("manager");
      expect(PersonStore.get(MANAGER_MANIFEST.id)?.revision).toBe(0);
      expect(supervisor.calls).toEqual(["materialize"]);
    } finally {
      await f.close();
    }
  });
  test("refusal leaves the Person unchanged and approvalId cannot mint authority", async () => {
    const { port } = portWith();
    const f = consentedDeclare(port, MANAGER_MANIFEST);
    try {
      expect((await f.answer("refuse")).isError).toBe(true);
      expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
      const forged = await personDeclare(port)({
        manifest: MANAGER_MANIFEST,
        approvalId: "invented",
      });
      expect(forged).toContain("Unrecognized key");
      expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  test("a collaborator declaration remains direct", async () => {
    const { port } = portWith();
    await personDeclare(port)({ manifest: { ...MANAGER_MANIFEST, trustTier: "collaborator" } });
    expect(PersonStore.get(MANAGER_MANIFEST.id)?.trustTier).toBe("collaborator");
  });
  test("the act itself refuses consent bound to a Person revision that no longer holds", async () => {
    const { port, supervisor } = portWith();
    const tool = createProvisionTool(port);
    const context = {
      sessionId: "provision-session",
      turnId: "provision-turn",
      callId: "stale-consent",
      signal: new AbortController().signal,
    };
    const declare = (domainRevisions: Record<string, number>) =>
      tool.execute(
        { operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST } } },
        { ...context, domainRevisions },
      );
    await expect(declare({ [MANAGER_MANIFEST.id]: 0 })).rejects.toThrow("domain revision changed");
    expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
    expect(await declare({ [MANAGER_MANIFEST.id]: -1 })).toMatchObject({
      op: "contact_add",
      result: { kind: "declared", id: MANAGER_MANIFEST.id, revision: 0 },
    });
    expect(supervisor.calls).toEqual(["materialize"]);
  });
  test("domain revision changes invalidate consent instead of applying a stale manifest", async () => {
    const { port } = portWith();
    const f = consentedDeclare(port, MANAGER_MANIFEST);
    try {
      await bounded(f.opened);
      PersonStore.put({
        ...MANAGER_MANIFEST,
        displayName: "Changed",
        trustTier: "observer",
        revision: 0,
        createdBy: "resident",
        updatedAt: NOW,
      });
      await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
      expect(PersonStore.get(MANAGER_MANIFEST.id)?.trustTier).toBe("observer");
    } finally {
      await f.close();
    }
  });
});

describe("owner Person protection and sole owner", () => {
  const ownerManifest = {
    id: "person:ino",
    displayName: "Ino",
    kind: "human" as const,
    trustTier: "owner" as const,
    endpoints: [{ channel: "telegram", externalId: "1" }],
  };
  function putOwner() {
    PersonStore.put({ ...ownerManifest, revision: 0, createdBy: "openomni-init", updatedAt: NOW });
  }
  test("same-tier owner endpoint edits suspend and apply only after consent", async () => {
    putOwner();
    const { port } = portWith();
    const edited = {
      ...ownerManifest,
      endpoints: [...ownerManifest.endpoints, { channel: "discord", externalId: "2" }],
    };
    const f = consentedDeclare(port, edited);
    try {
      await bounded(f.opened);
      expect(PersonStore.get(ownerManifest.id)?.endpoints).toHaveLength(1);
      expect((await f.answer()).isError).toBeUndefined();
      expect(PersonStore.get(ownerManifest.id)?.endpoints).toHaveLength(2);
      expect(PersonStore.get(ownerManifest.id)?.revision).toBe(1);
    } finally {
      await f.close();
    }
  });
  test("consent cannot bypass the sole-owner store invariant", async () => {
    putOwner();
    const { port } = portWith();
    const f = consentedDeclare(port, { ...ownerManifest, id: "person:second", endpoints: [] });
    try {
      expect((await f.answer()).isError).toBe(true);
      expect(PersonStore.get("person:second")).toBeUndefined();
      expect(PersonStore.get(ownerManifest.id)?.trustTier).toBe("owner");
    } finally {
      await f.close();
    }
  });
  test("contact_remove refuses the owner and removes other people", async () => {
    putOwner();
    PersonStore.put({
      ...MANAGER_MANIFEST,
      displayName: "Sunwoo",
      trustTier: "collaborator",
      revision: 0,
      createdBy: "resident",
      updatedAt: NOW,
    });
    const { port, supervisor } = portWith();
    expect(await personRemove(port)({ personId: ownerManifest.id })).toContain("sole owner");
    expect(await personRemove(port)({ personId: "person:ghost" })).toContain("does not exist");
    await personRemove(port)({ personId: MANAGER_MANIFEST.id });
    expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
    expect(supervisor.calls).toEqual(["removeIdentity:person:sunwoo"]);
  });
});

describe("channel administration ends in reconcile (§5, §8.7)", () => {
  test("channel_add validates the credential BEFORE anything lands", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { wrong: "field" },
    });
    expect(result).toContain("channel_add refused:");
    expect(ChannelInstanceStore.get("channel:telegram:main")).toBeUndefined();
    expect(SecretStore.get("secret:channel-telegram-main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("channel_add refuses an unregistered provider before anything lands", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:matrix:main",
      provider: "matrix",
      credential: { token: "x" },
    });
    expect(result).toContain("unknown provider matrix");
    expect(ChannelInstanceStore.get("channel:matrix:main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("§4 channel_add refuses unknown settings knobs — never accepted-and-ignored", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
      settings: { knob: "x" },
    });
    expect(result).toContain("channel_add refused:");
    expect(ChannelInstanceStore.get("channel:telegram:main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("a store refusal while landing the row surfaces as the tool's refusal, not a crash", async () => {
    const { port, supervisor } = portWith({
      instances: {
        ...ChannelInstanceStore,
        put: () => {
          throw new Provisioning.StoreError({
            message: "instance store is read-only during migration",
            code: "adapter_absent",
          });
        },
      },
    });
    const result = await channelDeclare(
      port,
      () => NOW,
    )({ id: "channel:telegram:main", provider: "telegram", credential: { token: "tg-token" } });
    expect(result).toBe("channel_add refused: instance store is read-only during migration");
    expect(supervisor.calls).toEqual([]);
  });

  test("a valid declaration seals the credential, lands the row, and reconciles", async () => {
    const { port, supervisor } = portWith();
    supervisor.statuses = [{ id: "channel:telegram:main", surface: "telegram", state: "mounted" }];
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    expect(result).toContain("channel channel:telegram:main declared");
    expect(result).toContain("channel:telegram:main → mounted");
    const instance = ChannelInstanceStore.get("channel:telegram:main");
    expect(instance?.credentialRef).toBe("secret:channel-telegram-main");
    expect(instance?.revision).toBe(0);
    const secret = SecretStore.get("secret:channel-telegram-main");
    if (secret === undefined) throw new Error("expected a sealed secret");
    const opened = Vault.open(secret, KEK).reveal();
    expect(new TextDecoder().decode(opened)).toBe('{"token":"tg-token"}');
    expect(supervisor.calls).toEqual(["reconcile"]);
  });

  test("a locked vault refuses to seal — declaration never half-lands", async () => {
    const { port } = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } });
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    expect(result).toContain("vault is locked (no OPENOMNI_VAULT_KEY)");
    expect(ChannelInstanceStore.get("channel:telegram:main")).toBeUndefined();
  });

  test("a locked vault refuses to rotate — the sealed secret stays as it was", async () => {
    const { port, supervisor } = portWith();
    await channelDeclare(
      port,
      () => NOW,
    )({ id: "channel:telegram:main", provider: "telegram", credential: { token: "old-token" } });
    const locked = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } }).port;
    const result = await secretRotate(
      locked,
      () => NOW + 10,
    )({ secretId: "secret:channel-telegram-main", credential: { token: "new-token" } });
    expect(result).toContain("secret_rotate refused: vault is locked (no OPENOMNI_VAULT_KEY)");
    expect(SecretStore.get("secret:channel-telegram-main")?.rotatedAt).toBeUndefined();
    expect(supervisor.calls).toEqual(["reconcile"]);
  });

  test("enable re-arms the breaker then reconciles; disable just reconciles", async () => {
    const { port, supervisor } = portWith();
    await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    supervisor.calls.length = 0;

    const disabled = await channelDisable(
      port,
      () => NOW + 1,
    )({
      instanceId: "channel:telegram:main",
    });
    expect(disabled).toContain("channel channel:telegram:main disabled");
    expect(ChannelInstanceStore.get("channel:telegram:main")?.enabled).toBe(false);
    expect(supervisor.calls).toEqual(["reconcile"]);

    const enabled = await channelEnable(
      port,
      () => NOW + 2,
    )({
      instanceId: "channel:telegram:main",
    });
    expect(enabled).toContain("channel channel:telegram:main enabled");
    expect(ChannelInstanceStore.get("channel:telegram:main")?.enabled).toBe(true);
    expect(ChannelInstanceStore.get("channel:telegram:main")?.revision).toBe(2);
    expect(supervisor.calls).toEqual(["reconcile", "resume:channel:telegram:main", "reconcile"]);

    expect(await channelEnable(port)({ instanceId: "channel:ghost:x" })).toContain(
      "is not declared",
    );
  });

  test("§8.7 secret_rotate keeps the id, bumps rotatedAt, and bounces via reconcile", async () => {
    const { port, supervisor } = portWith();
    await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "old-token" },
    });
    supervisor.calls.length = 0;

    const invalid = await secretRotate(
      port,
      () => NOW + 10,
    )({
      secretId: "secret:channel-telegram-main",
      credential: { wrong: "field" },
    });
    expect(invalid).toContain("secret_rotate refused: channel:telegram:main:");
    expect(SecretStore.get("secret:channel-telegram-main")?.rotatedAt).toBeUndefined();

    const rotated = await secretRotate(
      port,
      () => NOW + 10,
    )({
      secretId: "secret:channel-telegram-main",
      credential: { token: "new-token" },
    });
    expect(rotated).toContain("secret secret:channel-telegram-main rotated");
    const secret = SecretStore.get("secret:channel-telegram-main");
    expect(secret?.createdAt).toBe(NOW);
    expect(secret?.rotatedAt).toBe(NOW + 10);
    expect(supervisor.calls).toEqual(["reconcile"]);

    expect(
      await secretRotate(port)({ secretId: "secret:ghost", credential: { token: "x" } }),
    ).toContain("does not exist");
  });

  test("catalog gate: provisioning administration is the Resident's alone", () => {
    const { port } = portWith();
    const provisionTools = ["provision"];
    const resident = createTools(
      { provisioning: port },
      {
        role: "resident",
        depth: 0,
        sessionId: "s",
      },
    ).map((entry) => entry.name);
    const worker = createTools(
      { provisioning: port },
      {
        role: "worker",
        depth: 1,
        sessionId: "s",
      },
    ).map((entry) => entry.name);
    for (const name of provisionTools) {
      expect(resident).toContain(name);
      expect(worker).not.toContain(name);
    }
  });

  test("catalog gate: an uncomposed provisioning port keeps the tool and refuses", async () => {
    const result = await dispatchModelTool(
      "provision",
      {},
    )({
      operation: { op: "status", args: {} },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("provision refused: provisioning is not composed");
  });

  test("provision_status reports source, vault state, and per-instance verdicts", async () => {
    const { port, supervisor } = portWith();
    supervisor.statuses = [
      {
        id: "channel:telegram:main",
        surface: "telegram",
        state: "paused_by_breaker",
        detail: "3 consecutive start failures; channel_enable re-arms it",
      },
    ];
    const result = await provisionStatus(port)({});
    expect(result).toContain("channel source: declared");
    expect(result).toContain("vault open");
    expect(result).toContain("channel:telegram:main [telegram] → paused_by_breaker");
    // §4: the provider's operator checklist is reported verbatim for mounted surfaces.
    expect(result).not.toContain("precondition:");

    const slackPort = portWith();
    slackPort.supervisor.statuses = [
      { id: "channel:slack:hq", surface: "slack", state: "mounted" },
    ];
    const slackStatus = await provisionStatus(slackPort.port)({});
    expect(slackStatus).toContain(
      "slack precondition: Socket Mode enabled with an app-level token granted connections:write",
    );

    const locked = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } });
    expect(await provisionStatus(locked.port)({})).toContain(
      "vault_locked (no OPENOMNI_VAULT_KEY)",
    );
  });
});

describe("refusal branches", () => {
  test("malformed inputs refuse with the tool's typed refusal", async () => {
    const { port } = portWith();
    // Bare operations missing the envelope, and an envelope whose operation is not an object.
    const malformed: PlainObject[] = [
      { op: "contact_add", args: {} },
      { op: "contact_remove", args: {} },
      { op: "channel_add", args: {} },
      { op: "channel_enable", args: {} },
      { op: "secret_rotate", args: {} },
      { operation: "nope" },
    ];
    for (const input of malformed) {
      const result = await dispatchModelTool(
        "provision",
        { provisioning: port },
        RESIDENT,
        () => NOW,
      )(input);
      expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
      expect(result.output).toContain("provision refused");
    }
  });

  test("foreign approval identifiers are invalid rather than reusable authority", async () => {
    const { port } = portWith();
    const tool = eraseTool(createProvisionTool(port));
    for (const approvalId of ["contact-approval", "another-person-approval"]) {
      const result = await createDispatcher([tool], { executor }).execute(
        {
          id: approvalId,
          tool: "provision",
          input: {
            operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST, approvalId } },
          },
        },
        { sessionId: "test", turnId: "turn" },
      );
      expect(result.errorKind).toBe("invalid_input");
    }
    expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
  });

  test("missing request authority refuses instead of applying a protected mutation", async () => {
    const { port } = portWith();
    const result = await createDispatcher([eraseTool(createProvisionTool(port))], {
      executor,
    }).execute(
      {
        id: "no-authority",
        tool: "provision",
        input: { operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST } } },
      },
      { sessionId: "test", turnId: "turn" },
    );
    expect(result.errorKind).toBe("precondition_failed");
    expect(PersonStore.get(MANAGER_MANIFEST.id)).toBeUndefined();
  });

  test("a durable-write failure in channel_add is a typed refusal", async () => {
    const { port } = portWith({
      instances: {
        get: ChannelInstanceStore.get,
        list: ChannelInstanceStore.list,
        put: () => {
          throw new Error("disk full");
        },
      },
    });
    expect(
      await channelDeclare(
        port,
        () => NOW,
      )({
        id: "channel:telegram:main",
        provider: "telegram",
        credential: { token: "t" },
      }),
    ).toBe("channel_add refused: disk full");
  });
});
