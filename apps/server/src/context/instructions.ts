import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { findUp } from "./find-up";

const FILE_MAX_CHARS = 12_000;
const TOTAL_MAX_CHARS = 60_000;

interface InstructionFile {
  path: string;
  priority: number;
  label: string;
}

// Memoized: only the FIRST run for a given key pays the filesystem walk, so
// any warn below fires under that first run's trace — later runs hit the cache.
const discoverCache = new Map<string, InstructionFile[]>();
const loadCache = new Map<string, string>();

export namespace InstructionLoader {
  /** `traceId` is the assembling run's dispatch trace (D11) — loader warns inherit it, never mint. */
  export function discover(
    workspaceRoot: string,
    traceId: string,
    globalConfigDir?: string,
  ): InstructionFile[] {
    const key = `${workspaceRoot}\0${globalConfigDir ?? ""}`;
    const cached = discoverCache.get(key);
    if (cached) return cached;

    const results: InstructionFile[] = [];

    const globalDir = globalConfigDir ?? join(homedir(), ".openomni");
    const globalPath = join(globalDir, "AGENTS.md");
    if (existsSync(globalPath)) {
      results.push({ path: globalPath, priority: 0, label: "Global" });
    }

    const projectPath = findUp("AGENTS.md", workspaceRoot);
    if (projectPath) {
      results.push({ path: projectPath, priority: 10, label: "Project" });
    }

    const rulesDir = join(workspaceRoot, ".openomni", "rules");
    if (existsSync(rulesDir)) {
      try {
        const entries = readdirSync(rulesDir).sort();
        for (const entry of entries) {
          if (!entry.endsWith(".md")) continue;
          results.push({ path: join(rulesDir, entry), priority: 15, label: `Rules: ${entry}` });
        }
      } catch {
        Bus.publish(Operational.Warn, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "failed to read rules dir, skipping",
          context: { rulesDir },
        });
      }
    }

    const localPath = join(workspaceRoot, "AGENTS.local.md");
    if (existsSync(localPath)) {
      results.push({ path: localPath, priority: 20, label: "Local" });
    }

    const sorted = results.sort((a, b) => a.priority - b.priority);
    discoverCache.set(key, sorted);
    return sorted;
  }

  export function load(files: InstructionFile[], traceId: string): string {
    if (files.length === 0) return "";

    const key = files.map((f) => f.path).join("\0");
    const cached = loadCache.get(key);
    if (cached !== undefined) return cached;

    let output = "";

    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file.path, "utf-8");
      } catch {
        Bus.publish(Operational.Warn, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "failed to read instruction file, skipping",
          context: { path: file.path },
        });
        continue;
      }

      if (content.length > FILE_MAX_CHARS) {
        content = `${content.slice(0, FILE_MAX_CHARS)}\n[...truncated]`;
      }

      const section = `\n\n---\n**Instructions from ${file.label}:**\n\n${content}`;

      if (output.length + section.length > TOTAL_MAX_CHARS) {
        const remaining = TOTAL_MAX_CHARS - output.length;
        if (remaining > 0) {
          output += section.slice(0, remaining);
        }
        break;
      }

      output += section;
    }

    loadCache.set(key, output);
    return output;
  }
}
