import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Profile } from "../../src/profile";
import { MEMORY_GUIDANCE } from "../../src/profile/guidance";

async function createFixture(homeRoot: string, agentName: string, files: Record<string, string>) {
  const agentDir = join(homeRoot, ".openomni", "profiles", agentName);
  await mkdir(agentDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(agentDir, name), content);
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "profile-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("Profile", () => {
  describe("loader", () => {
    it("loads all three files when present", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "You are a helpful assistant.",
          "USER.md": "Name: Alice",
          "MEMORY.md": "User prefers dark mode",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const [soul, user, memory] = registrations;

        const soulVerdict = await soul.fn({} as any);
        expect(soulVerdict).toEqual({
          action: "transform",
          input: { prependContext: "═══ PERSONA IDENTITY ═══\nYou are a helpful assistant." },
        });

        const userVerdict = await user.fn({} as any);
        expect(userVerdict).toEqual({
          action: "transform",
          input: {
            appendContext: `\u2550\u2550\u2550 USER PROFILE \u2550\u2550\u2550\nName: Alice`,
          },
        });

        const memoryVerdict = await memory.fn({} as any);
        expect(memoryVerdict).toEqual({
          action: "transform",
          input: {
            appendContext: `\u2550\u2550\u2550 DECLARATIVE MEMORY \u2550\u2550\u2550\n${MEMORY_GUIDANCE}\n\nUser prefers dark mode`,
          },
        });
      });
    });

    it("merges global USER.md with agent-specific USER.md", async () => {
      await withTempDir(async (dir) => {
        const profilesDir = join(dir, ".openomni", "profiles");
        await mkdir(profilesDir, { recursive: true });
        await Bun.write(join(profilesDir, "USER.md"), "Global preferences");
        await createFixture(dir, "test-agent", {
          "USER.md": "Agent-specific prefs",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const userVerdict = await registrations[1].fn({} as any);

        expect(userVerdict).toEqual({
          action: "transform",
          input: {
            appendContext:
              "\u2550\u2550\u2550 USER PROFILE \u2550\u2550\u2550\nGlobal preferences\n\nAgent-specific prefs",
          },
        });
      });
    });

    it("uses global USER.md only when agent-specific is absent", async () => {
      await withTempDir(async (dir) => {
        const profilesDir = join(dir, ".openomni", "profiles");
        await mkdir(profilesDir, { recursive: true });
        await Bun.write(join(profilesDir, "USER.md"), "Global only");
        await createFixture(dir, "test-agent", {});

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const userVerdict = await registrations[1].fn({} as any);

        expect(userVerdict).toEqual({
          action: "transform",
          input: {
            appendContext: "\u2550\u2550\u2550 USER PROFILE \u2550\u2550\u2550\nGlobal only",
          },
        });
      });
    });

    it("uses agent-specific USER.md only when global is absent", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "USER.md": "Agent only",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const userVerdict = await registrations[1].fn({} as any);

        expect(userVerdict).toEqual({
          action: "transform",
          input: {
            appendContext: "\u2550\u2550\u2550 USER PROFILE \u2550\u2550\u2550\nAgent only",
          },
        });
      });
    });

    it("returns continue for missing files in empty directory", async () => {
      await withTempDir(async (dir) => {
        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        for (const reg of registrations) {
          const verdict = await reg.fn({} as any);
          expect(verdict).toEqual({ action: "continue" });
        }
      });
    });

    it("loads only SOUL.md when others are absent", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "Soul content only",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const soulVerdict = await registrations[0].fn({} as any);
        expect(soulVerdict).toEqual({
          action: "transform",
          input: { prependContext: "═══ PERSONA IDENTITY ═══\nSoul content only" },
        });

        const userVerdict = await registrations[1].fn({} as any);
        expect(userVerdict).toEqual({ action: "continue" });

        const memoryVerdict = await registrations[2].fn({} as any);
        expect(memoryVerdict).toEqual({ action: "continue" });
      });
    });

    it("sanitizes invalid agent name and returns empty content", async () => {
      await withTempDir(async (dir) => {
        const registrations = Profile.createMiddleware({
          agentName: "../etc/passwd",
          homeRoot: dir,
        });
        for (const reg of registrations) {
          const verdict = await reg.fn({} as any);
          expect(verdict).toEqual({ action: "continue" });
        }
      });
    });

    it("sanitizes dot-dot segment and returns empty content", async () => {
      await withTempDir(async (dir) => {
        const registrations = Profile.createMiddleware({ agentName: "..", homeRoot: dir });
        for (const reg of registrations) {
          const verdict = await reg.fn({} as any);
          expect(verdict).toEqual({ action: "continue" });
        }
      });
    });

    it("treats empty files as empty strings", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "",
          "USER.md": "",
          "MEMORY.md": "",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        for (const reg of registrations) {
          const verdict = await reg.fn({} as any);
          expect(verdict).toEqual({ action: "continue" });
        }
      });
    });
  });

  describe("middleware registration", () => {
    it("returns exactly 3 registrations", () => {
      const registrations = Profile.createMiddleware({
        agentName: "test",
        homeRoot: "/tmp/nonexistent",
      });
      expect(registrations).toHaveLength(3);
    });

    it("assigns correct names", () => {
      const registrations = Profile.createMiddleware({
        agentName: "test",
        homeRoot: "/tmp/nonexistent",
      });
      expect(registrations.map((r) => r.name)).toEqual([
        "profile:soul",
        "profile:user",
        "profile:memory",
      ]);
    });

    it("assigns priorities 25, 30, 35", () => {
      const registrations = Profile.createMiddleware({
        agentName: "test",
        homeRoot: "/tmp/nonexistent",
      });
      expect(registrations.map((r) => r.priority)).toEqual([25, 30, 35]);
    });

    it("all have on_system_prompt timing and fail-open policy", () => {
      const registrations = Profile.createMiddleware({
        agentName: "test",
        homeRoot: "/tmp/nonexistent",
      });
      for (const reg of registrations) {
        expect(reg.timing).toBe("on_system_prompt");
        expect(reg.failPolicy).toBe("fail-open");
      }
    });
  });

  describe("middleware behavior", () => {
    it("soul uses prependContext, user and memory use appendContext", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "soul",
          "USER.md": "user",
          "MEMORY.md": "memory",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const soulVerdict = await registrations[0].fn({} as any);
        expect(soulVerdict).toHaveProperty("input.prependContext");

        const userVerdict = await registrations[1].fn({} as any);
        expect(userVerdict).toHaveProperty("input.appendContext");

        const memoryVerdict = await registrations[2].fn({} as any);
        expect(memoryVerdict).toHaveProperty("input.appendContext");
      });
    });

    it("includes MEMORY_GUIDANCE in memory output only when content exists", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "MEMORY.md": "User likes TypeScript",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const verdict = await registrations[2].fn({} as any);

        expect(verdict).toEqual({
          action: "transform",
          input: {
            appendContext: `\u2550\u2550\u2550 DECLARATIVE MEMORY \u2550\u2550\u2550\n${MEMORY_GUIDANCE}\n\nUser likes TypeScript`,
          },
        });
      });
    });

    it("omits memory middleware when MEMORY.md is empty", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "MEMORY.md": "",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const verdict = await registrations[2].fn({} as any);
        expect(verdict).toEqual({ action: "continue" });
      });
    });
  });

  describe("frozen snapshot", () => {
    it("returns same result after underlying file changes", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "original soul",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const first = await registrations[0].fn({} as any);

        const soulPath = join(dir, ".openomni", "profiles", "test-agent", "SOUL.md");
        await Bun.write(soulPath, "modified soul");

        const second = await registrations[0].fn({} as any);
        expect(second).toEqual(first);
        expect(second).toEqual({
          action: "transform",
          input: { prependContext: "═══ PERSONA IDENTITY ═══\noriginal soul" },
        });
      });
    });

    it("new middleware instance picks up file changes", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "version one",
        });

        const first = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const firstVerdict = await first[0].fn({} as any);
        expect(firstVerdict).toEqual({
          action: "transform",
          input: { prependContext: "═══ PERSONA IDENTITY ═══\nversion one" },
        });

        const soulPath = join(dir, ".openomni", "profiles", "test-agent", "SOUL.md");
        await Bun.write(soulPath, "version two");

        const second = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });
        const secondVerdict = await second[0].fn({} as any);
        expect(secondVerdict).toEqual({
          action: "transform",
          input: { prependContext: "═══ PERSONA IDENTITY ═══\nversion two" },
        });
      });
    });

    it("snapshot is per-registration, not shared across all three", async () => {
      await withTempDir(async (dir) => {
        await createFixture(dir, "test-agent", {
          "SOUL.md": "soul content",
          "MEMORY.md": "memory content",
        });

        const registrations = Profile.createMiddleware({ agentName: "test-agent", homeRoot: dir });

        await registrations[0].fn({} as any);

        const memoryPath = join(dir, ".openomni", "profiles", "test-agent", "MEMORY.md");
        await Bun.write(memoryPath, "updated memory");

        const memoryVerdict = await registrations[2].fn({} as any);
        expect(memoryVerdict).toEqual({
          action: "transform",
          input: {
            appendContext: `\u2550\u2550\u2550 DECLARATIVE MEMORY \u2550\u2550\u2550\n${MEMORY_GUIDANCE}\n\nupdated memory`,
          },
        });
      });
    });
  });
});
