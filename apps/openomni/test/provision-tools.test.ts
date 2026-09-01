import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApprovalStore,
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
  Storage,
  Vault,
} from "@openomni/ledger";
import type { ChannelRuntimeStatus } from "../src/provisioning/supervisor";
import { catalogEntries } from "../src/tools/catalog";
import {
  channelDeclareToolExecutor,
  channelDisableToolExecutor,
  channelEnableToolExecutor,
  personDeclareToolExecutor,
  personManifestDigest,
  personRemoveToolExecutor,
  type ProvisionPort,
  provisionStatusToolExecutor,
  secretRotateToolExecutor,
} from "../src/tools/provision";

const NOW = 1_756_000_000_000;
const TRACE = "00-11111111111111111111111111111111-2222222222222222-01";
const BOUND = { windowMs: 3_600_000, maxPending: 8 } as const;
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
    approvals: {
      request: ApprovalStore.request,
      get: ApprovalStore.get,
      decision: ApprovalStore.decision,
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

function managerDigest(): string {
  return personManifestDigest({ ...MANAGER_MANIFEST, displayName: "person:sunwoo" });
}

function approvePersonMutation(id: string, personId: string, digest: string, at: number): void {
  ApprovalStore.request(
    {
      id,
      subject: { kind: "person_mutation", personId, manifestDigest: digest },
      deadline: at + 60_000,
    },
    BOUND,
    TRACE,
    at,
  );
  ApprovalStore.decide(id, "approved", TRACE, at + 1);
}

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("person_declare approval lane (§8.5)", () => {
  test("a raise above collaborator opens a digest-pinned approval instead of landing", async () => {
    const { port, supervisor } = portWith();
    const result = await personDeclareToolExecutor(port, () => NOW)({
      manifest: MANAGER_MANIFEST,
    });
    expect(result).toContain("requires Owner approval (§8.5)");
    expect(result).toContain(`digest ${managerDigest()}`);
    expect(PersonStore.get("person:sunwoo")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
    const match = /approval (approval:[0-9a-f-]+) opened/.exec(result);
    if (!match?.[1]) throw new Error(`no approval id in: ${result}`);
    expect(ApprovalStore.get(match[1])?.subject).toEqual({
      kind: "person_mutation",
      personId: "person:sunwoo",
      manifestDigest: managerDigest(),
    });

    // The Owner answers; the SAME manifest re-run with the approvalId lands.
    ApprovalStore.decide(match[1], "approved", TRACE, NOW + 1);
    const landed = await personDeclareToolExecutor(port, () => NOW + 5)({
      manifest: MANAGER_MANIFEST,
      approvalId: match[1],
    });
    expect(landed).toBe("person person:sunwoo declared (tier manager, revision 0)");
    expect(PersonStore.get("person:sunwoo")?.trustTier).toBe("manager");
    expect(supervisor.calls).toEqual(["materialize"]);
  });

  test("an approved, digest-matched mutation lands and materializes", async () => {
    const { port, supervisor } = portWith();
    approvePersonMutation("approval-1", "person:sunwoo", managerDigest(), NOW);
    const result = await personDeclareToolExecutor(port, () => NOW + 5)({
      manifest: MANAGER_MANIFEST,
      approvalId: "approval-1",
    });
    expect(result).toBe("person person:sunwoo declared (tier manager, revision 0)");
    expect(PersonStore.get("person:sunwoo")?.trustTier).toBe("manager");
    expect(supervisor.calls).toEqual(["materialize"]);
  });

  test("an approval unanswered past its deadline reads as refused", async () => {
    const { port } = portWith();
    ApprovalStore.request(
      {
        id: "approval-stale",
        subject: {
          kind: "person_mutation",
          personId: "person:sunwoo",
          manifestDigest: managerDigest(),
        },
        deadline: NOW + 10,
      },
      BOUND,
      TRACE,
      NOW,
    );
    const result = await personDeclareToolExecutor(port, () => NOW + 20)({
      manifest: MANAGER_MANIFEST,
      approvalId: "approval-stale",
    });
    expect(result).toContain("unanswered reads as refused");
    expect(PersonStore.get("person:sunwoo")).toBeUndefined();
  });

  test("a collaborator-or-below declaration is direct — no approval consumed", async () => {
    const { port } = portWith();
    const result = await personDeclareToolExecutor(port, () => NOW)({
      manifest: { ...MANAGER_MANIFEST, trustTier: "collaborator" },
    });
    expect(result).toContain("declared (tier collaborator");
    expect(PersonStore.get("person:sunwoo")?.trustTier).toBe("collaborator");
  });
});

describe("owner-Person mutation guard (§8.6) and sole owner (§8.8)", () => {
  const ownerManifest = {
    id: "person:ino",
    displayName: "Ino",
    kind: "human" as const,
    trustTier: "owner" as const,
    endpoints: [{ channel: "telegram", externalId: "1" }],
  };

  function putOwner(): void {
    PersonStore.put({ ...ownerManifest, revision: 0, createdBy: "openomni-init", updatedAt: NOW });
  }

  test("even a same-tier endpoint edit on the owner Person requires approval", async () => {
    putOwner();
    const { port } = portWith();
    const edited = {
      ...ownerManifest,
      endpoints: [{ channel: "telegram", externalId: "1" }, { channel: "discord", externalId: "2" }],
    };
    const refused = await personDeclareToolExecutor(port, () => NOW)({ manifest: edited });
    expect(refused).toContain("any mutation of the owner Person requires Owner approval (§8.6)");
    expect(PersonStore.get("person:ino")?.endpoints).toHaveLength(1);

    approvePersonMutation("approval-owner", "person:ino", personManifestDigest(edited), NOW);
    const landed = await personDeclareToolExecutor(port, () => NOW + 5)({
      manifest: edited,
      approvalId: "approval-owner",
    });
    expect(landed).toContain("declared (tier owner, revision 1)");
    expect(PersonStore.get("person:ino")?.endpoints).toHaveLength(2);
  });

  test("an approval for a different manifest digest is a refusal, not a fallback", async () => {
    putOwner();
    const { port } = portWith();
    approvePersonMutation("approval-other", "person:ino", "0".repeat(64), NOW);
    const result = await personDeclareToolExecutor(port, () => NOW + 5)({
      manifest: ownerManifest,
      approvalId: "approval-other",
    });
    expect(result).toContain("approved a different manifest (digest mismatch)");
    expect(PersonStore.get("person:ino")?.revision).toBe(0);
  });

  test("§8.8 a second owner surfaces the store's typed owner_exists refusal", async () => {
    putOwner();
    const { port } = portWith();
    const second = {
      id: "person:evil",
      kind: "human" as const,
      trustTier: "owner" as const,
      endpoints: [{ channel: "telegram", externalId: "666" }],
    };
    approvePersonMutation(
      "approval-second",
      "person:evil",
      personManifestDigest({ ...second, displayName: "person:evil" }),
      NOW,
    );
    const result = await personDeclareToolExecutor(port, () => NOW + 5)({
      manifest: second,
      approvalId: "approval-second",
    });
    expect(result).toContain("person_declare refused:");
    expect(result).toContain("person:ino");
    expect(PersonStore.get("person:evil")).toBeUndefined();
  });

  test("person_remove refuses the sole owner and removes anyone else", async () => {
    putOwner();
    PersonStore.put({
      id: "person:sunwoo",
      displayName: "Sunwoo",
      kind: "human",
      trustTier: "collaborator",
      endpoints: [],
      revision: 0,
      createdBy: "resident",
      updatedAt: NOW,
    });
    const { port, supervisor } = portWith();
    const executor = personRemoveToolExecutor(port);
    expect(await executor({ personId: "person:ino" })).toContain(
      "the sole owner Person cannot be removed",
    );
    expect(await executor({ personId: "person:ghost" })).toContain("does not exist");
    expect(await executor({ personId: "person:sunwoo" })).toBe("person person:sunwoo removed");
    expect(PersonStore.get("person:sunwoo")).toBeUndefined();
    expect(supervisor.calls).toEqual(["removeIdentity:person:sunwoo"]);
  });
});

describe("channel administration ends in reconcile (§5, §8.7)", () => {
  test("channel_declare validates the credential BEFORE anything lands", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclareToolExecutor(port, () => NOW)({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { wrong: "field" },
    });
    expect(result).toContain("channel_declare refused:");
    expect(ChannelInstanceStore.get("channel:telegram:main")).toBeUndefined();
    expect(SecretStore.get("secret:channel-telegram-main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("a valid declaration seals the credential, lands the row, and reconciles", async () => {
    const { port, supervisor } = portWith();
    supervisor.statuses = [{ id: "channel:telegram:main", surface: "telegram", state: "mounted" }];
    const result = await channelDeclareToolExecutor(port, () => NOW)({
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
    const result = await channelDeclareToolExecutor(port, () => NOW)({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    expect(result).toContain("vault is locked (no OPENOMNI_VAULT_KEY)");
    expect(ChannelInstanceStore.get("channel:telegram:main")).toBeUndefined();
  });

  test("enable re-arms the breaker then reconciles; disable just reconciles", async () => {
    const { port, supervisor } = portWith();
    await channelDeclareToolExecutor(port, () => NOW)({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    supervisor.calls.length = 0;

    const disabled = await channelDisableToolExecutor(port, () => NOW + 1)({
      instanceId: "channel:telegram:main",
    });
    expect(disabled).toContain("channel channel:telegram:main disabled");
    expect(ChannelInstanceStore.get("channel:telegram:main")?.enabled).toBe(false);
    expect(supervisor.calls).toEqual(["reconcile"]);

    const enabled = await channelEnableToolExecutor(port, () => NOW + 2)({
      instanceId: "channel:telegram:main",
    });
    expect(enabled).toContain("channel channel:telegram:main enabled");
    expect(ChannelInstanceStore.get("channel:telegram:main")?.enabled).toBe(true);
    expect(ChannelInstanceStore.get("channel:telegram:main")?.revision).toBe(2);
    expect(supervisor.calls).toEqual(["reconcile", "resume:channel:telegram:main", "reconcile"]);

    expect(await channelEnableToolExecutor(port)({ instanceId: "channel:ghost:x" })).toContain(
      "is not declared",
    );
  });

  test("§8.7 secret_rotate keeps the id, bumps rotatedAt, and bounces via reconcile", async () => {
    const { port, supervisor } = portWith();
    await channelDeclareToolExecutor(port, () => NOW)({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "old-token" },
    });
    supervisor.calls.length = 0;

    const invalid = await secretRotateToolExecutor(port, () => NOW + 10)({
      secretId: "secret:channel-telegram-main",
      credential: { wrong: "field" },
    });
    expect(invalid).toContain("secret_rotate refused: channel:telegram:main:");
    expect(SecretStore.get("secret:channel-telegram-main")?.rotatedAt).toBeUndefined();

    const rotated = await secretRotateToolExecutor(port, () => NOW + 10)({
      secretId: "secret:channel-telegram-main",
      credential: { token: "new-token" },
    });
    expect(rotated).toContain("secret secret:channel-telegram-main rotated");
    const secret = SecretStore.get("secret:channel-telegram-main");
    expect(secret?.createdAt).toBe(NOW);
    expect(secret?.rotatedAt).toBe(NOW + 10);
    expect(supervisor.calls).toEqual(["reconcile"]);

    expect(
      await secretRotateToolExecutor(port)({ secretId: "secret:ghost", credential: { token: "x" } }),
    ).toContain("does not exist");
  });

  test("catalog gate: provisioning administration is the Resident's alone", () => {
    const { port } = portWith();
    const provisionTools = [
      "person_declare",
      "person_remove",
      "channel_declare",
      "channel_enable",
      "channel_disable",
      "secret_rotate",
      "provision_status",
    ];
    const resident = catalogEntries({ provisioning: port }, {
      role: "resident",
      depth: 0,
      sessionId: "s",
    }).map((entry) => entry.spec.name);
    const worker = catalogEntries({ provisioning: port }, {
      role: "worker",
      depth: 1,
      sessionId: "s",
    }).map((entry) => entry.spec.name);
    const unwired = catalogEntries({}, { role: "resident", depth: 0, sessionId: "s" }).map(
      (entry) => entry.spec.name,
    );
    for (const name of provisionTools) {
      expect(resident).toContain(name);
      expect(worker).not.toContain(name);
      expect(unwired).not.toContain(name);
    }
  });

  test("provision_status reports source, vault state, and per-instance verdicts", async () => {
    const { port, supervisor } = portWith();
    supervisor.statuses = [
      { id: "channel:telegram:main", surface: "telegram", state: "paused_by_breaker", detail: "3 consecutive start failures; channel_enable re-arms it" },
    ];
    const result = await provisionStatusToolExecutor(port)({});
    expect(result).toContain("channel source: declared");
    expect(result).toContain("vault open");
    expect(result).toContain("channel:telegram:main [telegram] → paused_by_breaker");

    const locked = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } });
    expect(await provisionStatusToolExecutor(locked.port)({})).toContain(
      "vault_locked (no OPENOMNI_VAULT_KEY)",
    );
  });
});
