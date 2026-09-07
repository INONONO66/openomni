import type { PlainValue, PolicyRow, Storage } from "@openomni/protocol";

export type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

export function draft(
  name: string,
  kind: string,
  phase: PolicyRow.Phase,
  verdict: PlainValue,
  options: {
    readonly match?: PlainValue;
    readonly priority?: number;
  } = {},
): PolicyRowDraft {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: options.match ?? {} },
    verdict: { encodingVersion: 1, value: verdict },
    priority: options.priority ?? 0,
  };
}

export function atGeneration(row: PolicyRowDraft, generation: number): PolicyRow.Row {
  return { ...row, generation };
}

export class MemoryPolicyRows implements Pick<Storage.PolicyRowSubAdapter, "append" | "rows"> {
  readonly stored: PolicyRow.Row[];
  reads = 0;

  constructor(rows: readonly PolicyRow.Row[] = []) {
    this.stored = [...rows];
  }

  append(row: PolicyRow.Row): boolean {
    const duplicate = this.stored.some(
      (candidate) =>
        candidate.generation === row.generation &&
        candidate.name === row.name &&
        candidate.kind === row.kind &&
        candidate.phase === row.phase,
    );
    if (duplicate) return false;
    this.stored.push(row);
    return true;
  }

  rows(generation?: number): PolicyRow.Row[] {
    this.reads += 1;
    return this.stored.filter((row) => generation === undefined || row.generation === generation);
  }
}

export const compaction = draft(
  "compaction",
  "turn",
  "post",
  { type: "allow" },
  { match: { op: "compaction" }, priority: 1_000 },
);
