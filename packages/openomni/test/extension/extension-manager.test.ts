import { beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionEvent } from "@openomni/protocol";
import { EventLog, Session, SqliteStorageAdapter, Storage } from "@openomni/session";
import {
  ExtensionManager,
  type ExtensionManagerEntry,
  type ExtensionOperationOptions,
  type RuntimeBindingExtension,
} from "../../src/extension";

const fixedDate = new Date("2026-05-04T00:00:00.000Z");
const actor = { kind: "user", id: "tester" };
const subActor = { kind: "sub", id: "worker" };

let sessionId: string;

beforeEach(() => {
  Storage.configure(new SqliteStorageAdapter(":memory:"));
  sessionId = Session.create({
    title: "extension-manager-test",
    model: { providerID: "test", modelID: "test" },
  }).id;
});

describe("ExtensionManager", () => {
  it("validates manifests with parsed output, explicit errors, and audit rows", async () => {
    const valid = await ExtensionManager.validate(
      extensionManifest("alpha", "1.0.0"),
      operationOptions(),
    );
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.manifest.id).toBe("alpha");
      expect(valid.manifest.version).toBe("1.0.0");
    }

    const invalid = await ExtensionManager.validate(
      { id: "missing-required-fields" },
      operationOptions(),
    );
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.errors.length).toBeGreaterThan(0);
    }

    const events = await replayEvents();
    expect(events.map((event) => event.type)).toEqual([
      "action_requested",
      "policy_evaluated",
      "action_approved",
      "action_requested",
      "policy_evaluated",
      "action_approved",
    ]);
    expect(events[0]).toMatchObject({
      type: "action_requested",
      action: "extension.validate",
      resource: "alpha",
      input: { id: "alpha", version: "1.0.0", fieldCount: 5 },
    });
    expect(events[2]).toMatchObject({
      type: "action_approved",
      action: "extension.validate",
      resource: "alpha",
      reason: "extension manifest validation passed",
    });
    expect(events[3]).toMatchObject({
      type: "action_requested",
      action: "extension.validate",
      resource: "missing-required-fields",
      input: { id: "missing-required-fields", fieldCount: 1 },
    });
    expect(events[5]).toMatchObject({
      type: "action_approved",
      action: "extension.validate",
      resource: "missing-required-fields",
      reason: "extension manifest validation failed",
    });
    expect(events.some((event) => event.type === "bus_event")).toBe(false);
  });

  it("fails closed on validation guardrail denial without lifecycle rows", async () => {
    await expectRejectsWithMessage(
      ExtensionManager.validate(extensionManifest("denied", "1.0.0"), {
        ...operationOptions(),
        permission: { action: "extension.validate", denylist: ["denied"] },
      }),
      "denylist",
    );

    const events = await replayEvents();
    expect(events.map((event) => event.type)).toEqual([
      "action_requested",
      "policy_evaluated",
      "action_blocked",
    ]);
    expect(events[2]).toMatchObject({
      type: "action_blocked",
      action: "extension.validate",
      resource: "denied",
      verdict: "abort",
      reason: "denylist",
    });
    expect(events.some((event) => event.type === "bus_event")).toBe(false);
  });

  it("runs the extension lifecycle through replayable EventLog rows", async () => {
    const proposed = await ExtensionManager.requestInstall(extensionManifest("alpha", "1.0.0"), {
      ...operationOptions(),
      reason: "initial install",
    });
    expect(proposed).toMatchObject({ id: "alpha", version: "1.0.0", state: "proposed" });
    expect(proposed.manifest).toMatchObject({ id: "alpha", version: "1.0.0", permissionCount: 0 });

    await ExtensionManager.approve("alpha", operationOptions());
    await ExtensionManager.install("alpha", operationOptions());
    await ExtensionManager.enable("alpha", operationOptions());
    const disabled = await ExtensionManager.disable("alpha", {
      ...operationOptions(),
      reason: "maintenance",
    });
    expect(disabled).toMatchObject({ id: "alpha", version: "1.0.0", state: "disabled" });

    const listed = await ExtensionManager.list(operationOptions());
    expect(listed.map(entryState)).toEqual([["alpha", "1.0.0", "disabled"]]);

    const events = await replayEvents();
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(
      events
        .filter((event): event is ExecutionEvent.MirroredBusEvent => event.type === "bus_event")
        .map((event) => event.name),
    ).toEqual([
      "extension.proposed",
      "extension.approved",
      "extension.installed",
      "extension.enabled",
      "extension.disabled",
    ]);
    expect(
      events.every((event) => event.actionId.length > 0 && event.visibility === "internal"),
    ).toBe(true);
    expect(events.filter((event) => event.parentActionId !== undefined).length).toBeGreaterThan(0);
  });

  it("invokes runtime binding on enable and disable with replayed manifest components", async () => {
    const calls: string[] = [];
    const binding = {
      enable: async (extension: RuntimeBindingExtension): Promise<void> => {
        calls.push(`enable:${extension.id}:${extension.contributes?.tools?.[0]?.name ?? "none"}`);
      },
      disable: async (extension: RuntimeBindingExtension): Promise<void> => {
        calls.push(`disable:${extension.id}:${extension.contributes?.tools?.[0]?.name ?? "none"}`);
      },
    };

    await ExtensionManager.requestInstall(
      extensionManifestWithContributes("bound", "1.0.0"),
      operationOptions(),
    );
    await ExtensionManager.approve("bound", operationOptions());
    await ExtensionManager.install("bound", operationOptions());
    await ExtensionManager.enable("bound", { ...operationOptions(), binding });
    const disabled = await ExtensionManager.disable("bound", { ...operationOptions(), binding });

    expect(disabled).toMatchObject({ id: "bound", version: "1.0.0", state: "disabled" });
    expect(calls).toEqual(["enable:bound:bound.tool", "disable:bound:bound.tool"]);
  });

  it("records failed lifecycle state when runtime binding fails during enable", async () => {
    const binding = {
      enable: async (): Promise<void> => {
        throw new Error("binding unavailable");
      },
      disable: async (): Promise<void> => undefined,
    };

    await ExtensionManager.requestInstall(
      extensionManifestWithContributes("broken", "1.0.0"),
      operationOptions(),
    );
    await ExtensionManager.approve("broken", operationOptions());
    await ExtensionManager.install("broken", operationOptions());

    await expectRejectsWithMessage(
      ExtensionManager.enable("broken", { ...operationOptions(), binding }),
      "binding unavailable",
    );

    const listed = await ExtensionManager.list({ ...operationOptions(), extensionId: "broken" });
    expect(listed.map(entryState)).toEqual([["broken", "1.0.0", "failed"]]);

    const lifecycleEvents = (await replayEvents()).filter(
      (event): event is ExecutionEvent.MirroredBusEvent => event.type === "bus_event",
    );
    expect(lifecycleEvents.map((event) => event.name)).toEqual([
      "extension.proposed",
      "extension.approved",
      "extension.installed",
      "extension.failed",
    ]);
    expect(lifecycleEvents.at(-1)?.payload).toMatchObject({
      state: "failed",
      reason: "runtime_binding_failed",
      error: "binding unavailable",
    });
  });

  it("fails closed on guardrail denial before lifecycle side effects", async () => {
    await expectRejectsWithMessage(
      ExtensionManager.requestInstall(extensionManifest("denied", "1.0.0"), {
        ...operationOptions(),
        permission: { action: "extension.requestInstall", denylist: ["denied"] },
      }),
      "denylist",
    );

    const events = await replayEvents();
    expect(events.map((event) => event.type)).toEqual([
      "action_requested",
      "policy_evaluated",
      "action_blocked",
    ]);
    expect(events[2]).toMatchObject({
      type: "action_blocked",
      action: "extension.requestInstall",
      resource: "denied",
      verdict: "abort",
      reason: "denylist",
    });
    expect(events.some((event) => event.type === "bus_event")).toBe(false);
  });

  it("allows ordinary sub personas to request extension installs", async () => {
    const proposed = await ExtensionManager.requestInstall(
      extensionManifest("sub-requested", "1.0.0"),
      {
        ...operationOptions(subActor),
        reason: "worker suggestion",
      },
    );

    expect(proposed).toMatchObject({
      id: "sub-requested",
      version: "1.0.0",
      state: "proposed",
      actor: "sub:worker",
    });
    expect((await replayEvents()).some((event) => event.type === "action_blocked")).toBe(false);
  });

  it("denies ordinary sub persona approval before lifecycle side effects", async () => {
    await ExtensionManager.requestInstall(
      extensionManifest("sub-approve", "1.0.0"),
      operationOptions(subActor),
    );

    await expectRejectsWithMessage(
      ExtensionManager.approve("sub-approve", operationOptions(subActor)),
      "extension_authority_requires_user_main_or_trusted_manager",
    );

    const events = await replayEvents();
    expect(
      events
        .filter((event): event is ExecutionEvent.MirroredBusEvent => event.type === "bus_event")
        .map((event) => event.name),
    ).toEqual(["extension.proposed"]);
    expect(events.at(-2)).toMatchObject({
      type: "policy_evaluated",
      policyId: "guardrail.permission",
      actor: subActor,
      action: "extension.approve",
      resource: "sub-approve",
      verdict: "abort",
      reason: "extension_authority_requires_user_main_or_trusted_manager",
    });
    expect(events.at(-1)).toMatchObject({
      type: "action_blocked",
      policyId: "guardrail.permission",
      actor: subActor,
      action: "extension.approve",
      resource: "sub-approve",
      verdict: "abort",
      reason: "extension_authority_requires_user_main_or_trusted_manager",
    });
  });

  it("denies ordinary sub persona enable before runtime binding side effects", async () => {
    const calls: string[] = [];
    const binding = {
      enable: async (): Promise<void> => {
        calls.push("enable");
      },
      disable: async (): Promise<void> => undefined,
    };

    await ExtensionManager.requestInstall(
      extensionManifestWithContributes("sub-enable", "1.0.0"),
      operationOptions(),
    );
    await ExtensionManager.approve("sub-enable", operationOptions());
    await ExtensionManager.install("sub-enable", operationOptions());

    await expectRejectsWithMessage(
      ExtensionManager.enable("sub-enable", { ...operationOptions(subActor), binding }),
      "extension_authority_requires_user_main_or_trusted_manager",
    );

    const events = await replayEvents();
    expect(calls).toEqual([]);
    expect(
      events
        .filter((event): event is ExecutionEvent.MirroredBusEvent => event.type === "bus_event")
        .map((event) => event.name),
    ).toEqual(["extension.proposed", "extension.approved", "extension.installed"]);
    expect(events.at(-1)).toMatchObject({
      type: "action_blocked",
      policyId: "guardrail.permission",
      actor: subActor,
      action: "extension.enable",
      resource: "sub-enable",
      verdict: "abort",
      reason: "extension_authority_requires_user_main_or_trusted_manager",
    });
  });

  it("allows user, main, and trusted manager personas to approve and enable extensions", async () => {
    for (const kind of ["user", "main", "trusted_manager"]) {
      const extensionId = `allowed-${kind.replace("_", "-")}`;
      const authorizedActor = { kind, id: `${kind}-actor` };

      await ExtensionManager.requestInstall(
        extensionManifest(extensionId, "1.0.0"),
        operationOptions(authorizedActor),
      );
      await ExtensionManager.approve(extensionId, operationOptions(authorizedActor));
      await ExtensionManager.install(extensionId, operationOptions(authorizedActor));
      const enabled = await ExtensionManager.enable(extensionId, operationOptions(authorizedActor));

      expect(enabled).toMatchObject({
        id: extensionId,
        version: "1.0.0",
        state: "enabled",
        actor: `${kind}:${kind}-actor`,
      });
    }

    expect((await replayEvents()).some((event) => event.type === "action_blocked")).toBe(false);
  });

  it("blocks invalid state transitions without lifecycle rows", async () => {
    await ExtensionManager.requestInstall(extensionManifest("beta", "1.0.0"), operationOptions());

    await expectRejectsWithMessage(
      ExtensionManager.install("beta", operationOptions()),
      "cannot install",
    );

    const events = await replayEvents();
    expect(
      events
        .filter((event): event is ExecutionEvent.MirroredBusEvent => event.type === "bus_event")
        .map((event) => event.name),
    ).toEqual(["extension.proposed"]);
    expect(events.at(-1)).toMatchObject({
      type: "action_blocked",
      action: "extension.install",
      resource: "beta",
      reason: "invalid_lifecycle_transition",
    });
  });

  it("audits rollback source versions from EventLog history", async () => {
    await installAndEnable("gamma", "1.0.0");
    await installAndEnable("gamma", "2.0.0");

    const rolledBack = await ExtensionManager.rollback("gamma", {
      ...operationOptions(),
      version: "2.0.0",
      toVersion: "1.0.0",
      reason: "regression",
    });
    expect(rolledBack).toMatchObject({
      id: "gamma",
      version: "1.0.0",
      state: "rolled_back",
      fromVersion: "2.0.0",
      reason: "regression",
    });

    const listed = await ExtensionManager.list({ ...operationOptions(), extensionId: "gamma" });
    expect(listed.map(entryState)).toEqual([["gamma", "1.0.0", "rolled_back"]]);

    const audit = await ExtensionManager.audit({ ...operationOptions(), extensionId: "gamma" });
    const rollback = audit.find(
      (entry) => entry.kind === "lifecycle" && entry.name === "extension.rolled_back",
    );
    expect(rollback).toMatchObject({
      kind: "lifecycle",
      extensionId: "gamma",
      version: "1.0.0",
      state: "rolled_back",
      fromVersion: "2.0.0",
      actor: "user:tester",
      reason: "regression",
    });
  });
});

async function installAndEnable(id: string, version: string): Promise<void> {
  await ExtensionManager.requestInstall(extensionManifest(id, version), operationOptions());
  await ExtensionManager.approve(id, { ...operationOptions(), version });
  await ExtensionManager.install(id, { ...operationOptions(), version });
  await ExtensionManager.enable(id, { ...operationOptions(), version });
}

function operationOptions(
  operationActor: Record<string, unknown> = actor,
): ExtensionOperationOptions {
  return {
    actor: operationActor,
    audit: { sessionId },
    now: () => fixedDate,
  };
}

function extensionManifest(id: string, version: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version,
    description: `${id} extension`,
    provenance: { manifestHash: `${id}-${version}-hash` },
  };
}

function extensionManifestWithContributes(id: string, version: string): Record<string, unknown> {
  return {
    ...extensionManifest(id, version),
    contributes: {
      tools: [{ name: `${id}.tool`, inputSchema: {} }],
    },
  };
}

function entryState(
  entry: ExtensionManagerEntry,
): [string, string, ExtensionManagerEntry["state"]] {
  return [entry.id, entry.version, entry.state];
}

async function replayEvents(): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of EventLog.replay(sessionId)) {
    events.push(event);
  }
  return events;
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caughtError: unknown;
  try {
    await promise;
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);
  expect(caughtError instanceof Error ? caughtError.message : "").toContain(message);
}
