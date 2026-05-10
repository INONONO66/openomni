import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import type { Skill } from "@openomni/protocol";
import { Bus, Session, SqliteStorageAdapter, Storage } from "@openomni/session";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillLoader,
  SkillManager,
  SkillRegistry,
  type SkillOperationOptions,
} from "../../src/skill";

const fixedDate = new Date("2026-05-04T00:00:00.000Z");
const actor = { kind: "user", id: "tester" };

type AuditEvent = {
  readonly type: string;
  readonly sequence: number;
  readonly actor?: Record<string, unknown>;
  readonly action?: string;
  readonly resource?: string;
  readonly verdict?: string;
  readonly reason?: string;
  readonly visibility?: string;
  readonly input?: Record<string, unknown>;
};

let testRoot: string;
let projectRoot: string;
let homeRoot: string;
let sessionId: string;
let collectedEvents: AuditEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "openomni-skill-manager-"));
  projectRoot = join(testRoot, "project");
  homeRoot = join(testRoot, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });

  Storage.configure(new SqliteStorageAdapter(":memory:"));
  sessionId = Session.create({
    title: "skill-manager-test",
    model: { providerID: "test", modelID: "test" },
  }).id;

  collectedEvents = [];
  unsubscribe = Bus.subscribe(Operational.Info, (data) => {
    const audit = data.context?.audit;
    if (data.component === "skill.manager" && audit) {
      collectedEvents.push(audit as unknown as AuditEvent);
    }
  });
});

afterEach(async () => {
  unsubscribe();
  Bus.reset();
  Storage.reset();
  await rm(testRoot, { recursive: true, force: true });
});

describe("SkillManager", () => {
  it("installs global skills with registry updates, serialized prompt fragments, and audit rows", async () => {
    const installed = await SkillManager.install(
      skillDefinition("global-alpha", "global", "Use the global alpha behavior."),
      "file:///global-alpha",
      { ...operationOptions(), version: "1.2.3" },
    );

    expect(installed).toMatchObject({
      id: "global-alpha",
      scope: "global",
      enabled: true,
      source: "file:///global-alpha",
      version: "1.2.3",
      installedAt: fixedDate.getTime(),
    });
    expect(installed.path).toBe(join(homeRoot, ".openomni", "skills", "global-alpha", "SKILL.md"));

    const loaded = await SkillLoader.loadGlobal("global-alpha", { homeRoot });
    expect(loaded.promptFragment).toBe("Use the global alpha behavior.");

    const registry = await SkillRegistry.read({ homeRoot });
    expect(registry).toEqual([
      {
        id: "global-alpha",
        version: "1.2.3",
        installedAt: fixedDate.getTime(),
        source: "file:///global-alpha",
        enabled: true,
      },
    ]);

    const events = await replayEvents();
    expect(events.map((event) => event.type)).toEqual([
      "action_requested",
      "policy_evaluated",
      "action_approved",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]).toMatchObject({
      type: "policy_evaluated",
      actor,
      action: "skill.install",
      resource: "global-alpha",
      verdict: "continue",
      reason: "default_allow",
      visibility: "internal",
    });
    expect(events[2]).toMatchObject({
      type: "action_approved",
      actor,
      action: "skill.install",
      resource: "global-alpha",
      verdict: "continue",
    });
    expect(Object.keys(events[0].input ?? {})).not.toContain("promptFragment");
  });

  it("registers local skills without corrupting the global registry and lists both scopes", async () => {
    await SkillRegistry.write([registryEntry("global-zeta", true)], { homeRoot });

    await SkillManager.install(
      skillDefinition("local-alpha", "local", "Use the local alpha behavior."),
      "file:///local-alpha",
      operationOptions(),
    );
    const registry = await SkillRegistry.read({ homeRoot });
    expect(registry).toEqual([registryEntry("global-zeta", true)]);

    const local = await SkillLoader.loadLocal("local-alpha", { projectRoot });
    expect(local.promptFragment).toBe("Use the local alpha behavior.");

    const listed = await SkillManager.list(operationOptions());
    expect(listed.map((entry) => [entry.scope, entry.id, entry.enabled])).toEqual([
      ["global", "global-zeta", true],
      ["local", "local-alpha", true],
    ]);

    const events = await replayEvents();
    expect(
      events.some((event) => event.type === "action_approved" && event.action === "skill.list"),
    ).toBe(true);
  });

  it("enables, disables, and uninstalls global registry entries deterministically", async () => {
    await writeSkillFile("alpha");
    await writeSkillFile("beta");
    await SkillRegistry.write([registryEntry("beta", true), registryEntry("alpha", true)], {
      homeRoot,
    });

    await SkillManager.disable("beta", operationOptions());
    expect(
      (await SkillRegistry.read({ homeRoot })).map((entry) => [entry.id, entry.enabled]),
    ).toEqual([
      ["alpha", true],
      ["beta", false],
    ]);

    await SkillManager.enable("beta", operationOptions());
    expect(
      (await SkillRegistry.read({ homeRoot })).map((entry) => [entry.id, entry.enabled]),
    ).toEqual([
      ["alpha", true],
      ["beta", true],
    ]);

    await SkillManager.uninstall("alpha", operationOptions());
    expect((await SkillRegistry.read({ homeRoot })).map((entry) => entry.id)).toEqual(["beta"]);
    expect(
      await Bun.file(join(homeRoot, ".openomni", "skills", "alpha", "SKILL.md")).exists(),
    ).toBe(false);

    await expectRejectsWithMessage(
      SkillManager.enable("missing", operationOptions()),
      "not installed globally",
    );
    const events = await replayEvents();
    expect(events.at(-1)).toMatchObject({
      type: "action_blocked",
      action: "skill.enable",
      resource: "missing",
      verdict: "abort",
      reason: "skill_not_installed",
    });
  });

  it("audits denied guardrail decisions and fails before file or registry side effects", async () => {
    await expectRejectsWithMessage(
      SkillManager.install(
        skillDefinition("denied", "global", "Do not write this skill."),
        "file:///denied",
        {
          ...operationOptions(),
          permission: { action: "skill.install", denylist: ["denied"] },
        },
      ),
      "denied",
    );

    expect(
      await Bun.file(join(homeRoot, ".openomni", "skills", "denied", "SKILL.md")).exists(),
    ).toBe(false);
    expect(await SkillRegistry.read({ homeRoot })).toEqual([]);

    const events = await replayEvents();
    expect(events.map((event) => event.type)).toEqual([
      "action_requested",
      "policy_evaluated",
      "action_blocked",
    ]);
    expect(events[2]).toMatchObject({
      type: "action_blocked",
      action: "skill.install",
      resource: "denied",
      verdict: "abort",
      reason: "denylist",
    });
  });

  it("proceeds with operations when Bus audit is fire-and-forget", async () => {
    const installed = await SkillManager.install(
      skillDefinition("audit-ok", "global", "Bus audit is best-effort."),
      "file:///audit-ok",
      operationOptions(),
    );

    expect(installed.id).toBe("audit-ok");
    expect(
      await Bun.file(join(homeRoot, ".openomni", "skills", "audit-ok", "SKILL.md")).exists(),
    ).toBe(true);
  });
});

function operationOptions(): SkillOperationOptions {
  return {
    actor,
    audit: { sessionId },
    projectRoot,
    homeRoot,
    now: () => fixedDate,
  };
}

function skillDefinition(id: string, scope: Skill.Scope, promptFragment: string): Skill.Definition {
  return {
    id,
    name: id,
    description: `${id} description`,
    scope,
    layer: "enhancement",
    path: `${scope}:${id}`,
    promptFragment,
  };
}

function registryEntry(id: string, enabled: boolean): Skill.RegistryEntry {
  return {
    id,
    version: "1.0.0",
    installedAt: 1_714_800_000_000,
    enabled,
  };
}

async function writeSkillFile(id: string): Promise<void> {
  const root = join(homeRoot, ".openomni", "skills", id);
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "SKILL.md"),
    [
      "---",
      `id: ${id}`,
      `name: ${id}`,
      `description: ${id} description`,
      "layer: enhancement",
      "---",
      "",
      `${id} prompt`,
      "",
    ].join("\n"),
  );
}

async function replayEvents(): Promise<AuditEvent[]> {
  // Bus.publish delivers via queueMicrotask; flush pending deliveries
  await new Promise((resolve) => queueMicrotask(resolve));
  return collectedEvents;
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caughtError: unknown;
  try {
    await promise;
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);
  expect((caughtError as Error).message).toContain(message);
}
