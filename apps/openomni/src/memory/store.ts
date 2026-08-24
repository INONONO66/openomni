import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The built-in memory layer (kernel-contract §5): two bounded curated
 * stores the Resident maintains through the memory tool and reads as a
 * frozen snapshot injected into its system prompt at session start.
 *
 * Hard character budgets are the point, not a safeguard: memory cannot
 * bloat context, so growth forces curation — replace and remove are
 * first-class. The budget is enforced HERE, at write time, and nowhere
 * else (one enforcement layer per invariant).
 */

export const MEMORY_STORES = ["system", "owner"] as const;
type MemoryStoreName = (typeof MEMORY_STORES)[number];

/** ~4 chars per token; 800 tokens of system notes, 500 of Owner profile. */
const BUDGET_CHARS: Record<MemoryStoreName, number> = {
  system: 3200,
  owner: 2000,
};

const Entry = z.object({ id: z.string().min(1), content: z.string().min(1) });
const FileShape = z.object({
  system: z.array(Entry),
  owner: z.array(Entry),
});
type MemoryFile = z.infer<typeof FileShape>;

export interface CuratedMemory {
  add(store: MemoryStoreName, content: string): string;
  replace(store: MemoryStoreName, id: string, content: string): void;
  remove(store: MemoryStoreName, id: string): void;
  /** The full snapshot as it renders into the system prompt. */
  render(): string;
}

export class MemoryRefusal extends Error {}

function usedChars(entries: readonly z.infer<typeof Entry>[]): number {
  return entries.reduce((sum, entry) => sum + entry.content.length, 0);
}

function loadFile(path: string): MemoryFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { system: [], owner: [] };
    }
    throw error;
  }
  return FileShape.parse(JSON.parse(raw));
}

const STORE_TITLES: Record<MemoryStoreName, string> = {
  system: "System notes",
  owner: "Owner profile",
};

function renderSnapshot(file: MemoryFile): string {
  const sections = MEMORY_STORES.flatMap((store) => {
    const entries = file[store];
    if (entries.length === 0) return [];
    const lines = entries.map((entry) => `- [${entry.id}] ${entry.content}`);
    return [`## ${STORE_TITLES[store]}\n${lines.join("\n")}`];
  });
  if (sections.length === 0) return "";
  return `# Memory\n\n${sections.join("\n\n")}`;
}

/**
 * File-backed store. Writes are atomic (tmp + rename) so a crash mid-write
 * never leaves a torn file, and every mutation persists before it returns —
 * a durable write that silently skipped persistence would be a lie the next
 * session acts on.
 */
export function openCuratedMemory(path: string): CuratedMemory {
  mkdirSync(dirname(path), { recursive: true });
  const file = loadFile(path);

  function persist(): void {
    const tmp = join(dirname(path), `.memory-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, path);
  }

  function assertBudget(store: MemoryStoreName, nextChars: number): void {
    const budget = BUDGET_CHARS[store];
    if (nextChars > budget) {
      throw new MemoryRefusal(
        `${store} store budget exceeded: ${nextChars}/${budget} chars — curate first (replace or remove an entry)`,
      );
    }
  }

  function entryAt(store: MemoryStoreName, id: string): { index: number; content: string } {
    const index = file[store].findIndex((entry) => entry.id === id);
    const entry = file[store][index];
    if (entry === undefined) {
      throw new MemoryRefusal(`no entry "${id}" in the ${store} store`);
    }
    return { index, content: entry.content };
  }

  return {
    add(store, content) {
      assertBudget(store, usedChars(file[store]) + content.length);
      const id = crypto.randomUUID().slice(0, 8);
      file[store].push({ id, content });
      persist();
      return id;
    },
    replace(store, id, content) {
      const existing = entryAt(store, id);
      assertBudget(store, usedChars(file[store]) - existing.content.length + content.length);
      file[store][existing.index] = { id, content };
      persist();
    },
    remove(store, id) {
      file[store].splice(entryAt(store, id).index, 1);
      persist();
    },
    render() {
      return renderSnapshot(file);
    },
  };
}
