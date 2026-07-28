import type { Tool } from "@openomni/protocol";

export function hasUnknownSettlement(result: Tool.Result): boolean {
  return result.settlement === "unknown";
}
