import type { Guardrail } from "@openomni/protocol";

export namespace ToolGuard {
  export function check(
    toolName: string,
    permission: Guardrail.ToolPermission,
  ): "allow" | "deny" | "require_approval" {
    if (permission.denylist?.includes(toolName)) return "deny";
    if (permission.requireApproval?.includes(toolName)) return "require_approval";
    if (permission.allowlist !== undefined) {
      if (permission.allowlist.length === 0) return "deny";
      if (permission.allowlist.includes("*")) return "allow";
      const prefixMatch = permission.allowlist.some(
        (p: string) => p.endsWith(".*") && toolName.startsWith(p.slice(0, -1)),
      );
      if (prefixMatch) return "allow";
      return permission.allowlist.includes(toolName) ? "allow" : "deny";
    }
    return "allow";
  }
}
