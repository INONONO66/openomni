import { canonicalDigest, type Message } from "@openomni/protocol";

export type CanonicalConversationEntry = Message.WithParts;

export interface CompactionRecord {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly discarded: {
    readonly firstEntryId: string;
    readonly lastEntryId: string;
    readonly count: number;
    readonly sha256: string;
  };
  readonly revert: {
    readonly removedEntries: readonly CanonicalConversationEntry[];
    readonly priorAnchorEntryId: string | null;
  };
}

export interface CompactionPlan {
  readonly projection: readonly CanonicalConversationEntry[];
  readonly record: CompactionRecord;
}

export function createCompactionPlan(
  prior: readonly CanonicalConversationEntry[],
  replacement: readonly CanonicalConversationEntry[],
  tokensBefore: number,
): CompactionPlan {
  const originals = structuredClone(prior);
  const shared = sharedSuffixLength(originals, replacement);
  const finalOriginal = originals.at(-1);
  if (finalOriginal === undefined) {
    throw new Error("compaction requires original history");
  }
  // A full rewrite still retains one unchanged atomic entry. Replace an
  // elided same-ID copy rather than introducing duplicate entry identities.
  const projection =
    shared > 0
      ? replacement
      : [...replacement.filter((entry) => entry.info.id !== finalOriginal.info.id), finalOriginal];
  const suffixLength = Math.max(1, shared);
  const firstKept = originals[originals.length - suffixLength];
  if (firstKept === undefined) {
    throw new Error("compaction projection must contain at least one entry");
  }
  const removedEntries = originals.slice(0, originals.length - suffixLength);
  const firstRemoved = removedEntries[0];
  const lastRemoved = removedEntries.at(-1);
  if (firstRemoved === undefined || lastRemoved === undefined) {
    throw new Error("compaction projection must discard at least one prior entry");
  }

  return {
    projection,
    record: {
      summary: compactionSummary(replacement),
      firstKeptEntryId: firstKept.info.id,
      tokensBefore,
      discarded: {
        firstEntryId: firstRemoved.info.id,
        lastEntryId: lastRemoved.info.id,
        count: removedEntries.length,
        sha256: canonicalDigest(removedEntries),
      },
      revert: {
        removedEntries,
        priorAnchorEntryId: latestAnchorId(removedEntries),
      },
    },
  };
}

export function restoreCompactionProjection(
  projection: readonly CanonicalConversationEntry[],
  record: CompactionRecord,
): CanonicalConversationEntry[] {
  if (canonicalDigest(record.revert.removedEntries) !== record.discarded.sha256) {
    throw new Error("compaction revert payload digest mismatch");
  }
  const firstKeptIndex = projection.findIndex((entry) => entry.info.id === record.firstKeptEntryId);
  if (firstKeptIndex < 0)
    throw new Error("compaction projection no longer contains first kept entry");

  return [...record.revert.removedEntries, ...projection.slice(firstKeptIndex)];
}

function sharedSuffixLength(
  prior: readonly CanonicalConversationEntry[],
  replacement: readonly CanonicalConversationEntry[],
): number {
  let count = 0;
  while (count < prior.length && count < replacement.length) {
    const before = prior[prior.length - count - 1];
    const after = replacement[replacement.length - count - 1];
    if (
      before === undefined ||
      after === undefined ||
      canonicalDigest(before) !== canonicalDigest(after)
    ) {
      break;
    }
    count += 1;
  }
  return count;
}

function isAnchorEntry(entry: CanonicalConversationEntry): boolean {
  return (
    entry.info.role === "user" &&
    entry.parts.some((part) => part.type === "text" && part.metadata?.compactionAnchor === true)
  );
}

function latestAnchorId(entries: readonly CanonicalConversationEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && isAnchorEntry(entry)) {
      return entry.info.id;
    }
  }
  return null;
}

function compactionSummary(entries: readonly CanonicalConversationEntry[]): string {
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.type !== "text" || part.metadata?.compactionAnchor !== true) continue;
      const body = part.metadata.anchorBody;
      return typeof body === "string" ? body : part.text;
    }
  }
  return "";
}
