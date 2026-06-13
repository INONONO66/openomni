import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LocalCliTemplateValues } from "./local-cli-agent-env.js";
import { renderLocalCliTemplate } from "./local-cli-agent-env.js";

export interface LocalCliLogSnapshot {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export function resolveLocalCliLogPath(
  pathTemplate: string,
  values: LocalCliTemplateValues,
): string {
  const workspaceKey =
    values.worktree === undefined ? "" : encodeWorkspaceForClaudeProjects(values.worktree);
  const withWorkspace = pathTemplate.split("{{workspaceHash}}").join(workspaceKey);
  const rendered = renderLocalCliTemplate(withWorkspace, values);
  if (rendered === "~") return homeDir();
  if (rendered.startsWith("~/")) return join(homeDir(), rendered.slice(2));
  return rendered;
}

export function newestLocalCliGlobMatch(path: string): string | undefined {
  const dir = dirname(path);
  const filePattern = basename(path);
  if (!existsSync(dir)) return undefined;
  const regex = new RegExp(`^${escapeRegExp(filePattern).split("\\*").join(".*")}$`);
  return readdirSync(dir)
    .filter((entry) => regex.test(entry))
    .map((entry) => join(dir, entry))
    .sort((left, right) => {
      const timeDelta = statSync(right).mtimeMs - statSync(left).mtimeMs;
      return timeDelta === 0 ? left.localeCompare(right) : timeDelta;
    })
    .at(0);
}

export function readLocalCliLogSnapshot(
  pathTemplate: string,
  values: LocalCliTemplateValues,
): LocalCliLogSnapshot | undefined {
  const resolved = resolveLocalCliLogPath(pathTemplate, values);
  const path = resolved.includes("*") ? newestLocalCliGlobMatch(resolved) : resolved;
  if (path === undefined || !existsSync(path)) return undefined;
  const stats = statSync(path);
  if (!stats.isFile()) return undefined;
  return { path, mtimeMs: stats.mtimeMs, size: stats.size };
}

export function encodeWorkspaceForClaudeProjects(workspace: string): string {
  return workspace.split("/").join("-").split("\\").join("-");
}

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
