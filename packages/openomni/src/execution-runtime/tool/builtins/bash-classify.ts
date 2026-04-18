const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "pwd",
  "which",
  "head",
  "tail",
  "wc",
  "echo",
  "find",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "describe",
  "ls-files",
]);

const SHELL_OPERATORS = /[;&|><`$()]|\|\||&&/;

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^rm\s+-rf?(\s|$)/,
  /^git\s+push(\s|$)/,
  /^git\s+reset\s+--hard(\s|$)/,
  /^git\s+clean\s+-f/,
  /^mv(\s|$)/,
  /^chmod(\s|$)/,
];

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_OPERATORS.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (!head) return false;
  if (head === "git") {
    const sub = tokens[1];
    return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return READ_ONLY_COMMANDS.has(head);
}

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

export function readCommandFromMeta(input: unknown): string {
  if (input && typeof input === "object" && "command" in input) {
    const value = (input as { command?: unknown }).command;
    if (typeof value === "string") return value;
  }
  return "";
}
