import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResidentProfile } from "../src/profile/resident";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };
const tempDirs: string[] = [];

afterEach(() =>
  Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))).then(
    () => undefined,
  ),
);

async function createProfileDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openomni-resident-profile-"));
  tempDirs.push(dir);
  return dir;
}

describe("resident profile", () => {
  it("requires SOUL.md", async () => {
    const profileDir = await createProfileDir();

    await expectProfileFailure(profileDir, "resident profile requires");
  });

  it("builds the resident agent from local profile files", async () => {
    const profileDir = await createProfileDir();
    await Bun.write(path.join(profileDir, "SOUL.md"), "You are the local resident.");
    await Bun.write(path.join(profileDir, "USER.md"), "The user prefers Korean.");
    await Bun.write(path.join(profileDir, "MEMORY.md"), "Remember the current project.");
    await Bun.write(
      path.join(profileDir, "config.yaml"),
      "name: Hermes\ndescription: Local relationship owner\nmaxTurns: 7\n",
    );

    const profile = await createResidentProfile({ profileDir, model });
    const agent = profile.factory();
    profile.close();

    expect(profile.metadata.name).toBe("resident");
    expect(profile.metadata.description).toBe("Local relationship owner");
    expect(agent.name).toBe("resident");
    expect(agent.description).toBe("Local relationship owner");
    expect(agent.model).toEqual(model);
    expect(agent.systemPrompt).toContain("You are the local resident.");
    expect(agent.systemPrompt).toContain("## Profile\nName: Hermes");
    expect(agent.systemPrompt).toContain("## User\nThe user prefers Korean.");
    expect(agent.systemPrompt).toContain("## Memory\nRemember the current project.");
    expect(agent.tools).toEqual({ categories: ["custom"] });
    expect(agent.budget?.maxTurns).toBe(7);
  });

  it("uses the latest snapshot after profile files change", async () => {
    const profileDir = await createProfileDir();
    await Bun.write(path.join(profileDir, "SOUL.md"), "Initial soul.");

    const profile = await createResidentProfile({ profileDir, model });
    await Bun.write(path.join(profileDir, "SOUL.md"), "Updated soul.");

    await waitFor(() => profile.factory().systemPrompt.includes("Updated soul."));
    profile.close();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for resident profile reload");
}

async function expectProfileFailure(profileDir: string, expected: string): Promise<void> {
  try {
    await createResidentProfile({ profileDir, model });
  } catch (err) {
    expect(err instanceof Error ? err.message : String(err)).toContain(expected);
    return;
  }
  throw new Error("expected resident profile creation to fail");
}
