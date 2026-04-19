import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Log } from "@openomni/session";
import { findUp } from "./find-up";

const FILE_MAX_CHARS = 12_000;
const TOTAL_MAX_CHARS = 60_000;

export interface InstructionFile {
  path: string;
  priority: number;
  label: string;
}

export namespace InstructionLoader {
  export function discover(workspaceRoot: string, globalConfigDir?: string): InstructionFile[] {
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
        Log.warn("failed to read rules dir, skipping", { rulesDir });
      }
    }

    const localPath = join(workspaceRoot, "AGENTS.local.md");
    if (existsSync(localPath)) {
      results.push({ path: localPath, priority: 20, label: "Local" });
    }

    return results.sort((a, b) => a.priority - b.priority);
  }

  export function load(files: InstructionFile[]): string {
    if (files.length === 0) return "";

    let output = "";

    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file.path, "utf-8");
      } catch {
        Log.warn("failed to read instruction file, skipping", { path: file.path });
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

    return output;
  }
}
