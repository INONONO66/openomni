import {
  Capability,
  CompactionSeam,
  type CapabilityDefinition,
  type CompactionSeamService,
  type SeamTag,
} from "../../core/api";
import { Compaction } from "./compact";
import { DEFAULT_PROTECT_RECENT } from "./contract";
import { estimateMessagesTokens } from "./estimate";
import { executeCompaction } from "./execute-cut";
import { resolveCompactionGeometry } from "./geometry";
import { measuredContextTokens } from "./measure";
import { prepareCompactionRestore } from "./restore";
import { CompactionSession } from "./speculate";
import { createCompactionPin, type CompactionHistoryPorts } from "./successor";

export { Compaction } from "./compact";
export { CompactionSession } from "./speculate";
export type { CompactionHistoryPorts } from "./successor";

/**
 * The seam service (#1307): every member IS the module export the kernel used
 * to import directly — one frozen object, reached only through composition.
 */
export function compactionSeamService(history: CompactionHistoryPorts): CompactionSeamService {
  return Object.freeze({
    protectRecent: DEFAULT_PROTECT_RECENT,
    geometry: resolveCompactionGeometry,
    measure: measuredContextTokens,
    estimate: estimateMessagesTokens,
    shouldCompact: Compaction.shouldCompact,
    execute: executeCompaction,
    createSession: (config) => new CompactionSession(config),
    pinAction: createCompactionPin(history),
    prepareRestore: prepareCompactionRestore,
  } satisfies CompactionSeamService);
}

/**
 * The removable `plugins/compaction` capability (#1307): no new journal kind
 * (`compaction` rows ship with the core fold), no point, no input, no model
 * tool — exactly the seam service the kernel's commit, restore, and run-loop
 * paths consume. Off = those paths skip compaction and record nothing new.
 */
export function compactionCapability(
  history: CompactionHistoryPorts,
): CapabilityDefinition<"compaction", SeamTag, CompactionSeamService> {
  return Capability.define({
    name: "compaction",
    requires: [],
    verbs: compactionSeamService(history),
    seam: CompactionSeam,
  });
}
