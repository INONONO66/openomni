import { Hashline } from "./hashline.js";

export interface PlanDocument {
  planId: string;
  content: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type EditResult = { ok: true; content: string } | { ok: false; errors: string[] };

export interface PlanStore {
  write(planId: string, content: string): void;
  read(planId: string): PlanDocument | undefined;
  edit(planId: string, edits: Hashline.EditOp[]): EditResult;
  delete(planId: string): boolean;
}

interface StoreEntry {
  content: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export class InMemoryPlanStore implements PlanStore {
  private readonly entries = new Map<string, StoreEntry>();

  write(planId: string, content: string): void {
    const existing = this.entries.get(planId);

    if (existing) {
      existing.content = content;
      existing.version++;
      existing.updatedAt = Date.now();
    } else {
      const now = Date.now();
      this.entries.set(planId, {
        content,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  read(planId: string): PlanDocument | undefined {
    const entry = this.entries.get(planId);
    if (!entry) return undefined;

    return {
      planId,
      content: entry.content,
      version: entry.version,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  edit(planId: string, edits: Hashline.EditOp[]): EditResult {
    const entry = this.entries.get(planId);
    if (!entry) {
      return { ok: false, errors: [`Plan not found: ${planId}`] };
    }

    const result = Hashline.applyEdits(entry.content, edits);

    if (!result.ok) {
      return result;
    }

    entry.content = result.content;
    entry.version++;
    entry.updatedAt = Date.now();

    return { ok: true, content: result.content };
  }

  delete(planId: string): boolean {
    return this.entries.delete(planId);
  }
}
