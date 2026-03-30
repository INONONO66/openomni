export namespace Guard {
  export interface ToolCallRecord {
    tool: string;
    inputHash: string;
  }

  export function isDoomLoop(history: ToolCallRecord[], current: ToolCallRecord): boolean {
    if (history.length < 2) return false;
    const last2 = history.slice(-2);
    return last2.every((h) => h.tool === current.tool && h.inputHash === current.inputHash);
  }

  export function hashInput(input: unknown): string {
    return JSON.stringify(input) ?? "";
  }
}
