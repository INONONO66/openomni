import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ConnectorTemplateValues } from "./env.js";
import { renderConnectorTemplate } from "./env.js";

export interface ConnectorLogSnapshot {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export function resolveConnectorLogPath(
  pathTemplate: string,
  values: ConnectorTemplateValues,
): string {
  const workspaceKey = encodeWorktreeForClaudeProjects(values.worktree);
  const withWorkspace = pathTemplate.split("{{workspaceHash}}").join(workspaceKey);
  const rendered = renderConnectorTemplate(withWorkspace, values);
  if (rendered === "~") return homeDir();
  if (rendered.startsWith("~/")) return join(homeDir(), rendered.slice(2));
  return rendered;
}

export function newestConnectorGlobMatch(path: string): string | undefined {
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

export function readConnectorLogSnapshot(
  pathTemplate: string,
  values: ConnectorTemplateValues,
): ConnectorLogSnapshot | undefined {
  const resolved = resolveConnectorLogPath(pathTemplate, values);
  const path = resolved.includes("*") ? newestConnectorGlobMatch(resolved) : resolved;
  if (path === undefined || !existsSync(path)) return undefined;
  const stats = statSync(path);
  if (!stats.isFile()) return undefined;
  return { path, mtimeMs: stats.mtimeMs, size: stats.size };
}

export function encodeWorktreeForClaudeProjects(workspace: string): string {
  return workspace.split("/").join("-").split("\\").join("-");
}

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
