/**
 * `Bundle` namespace assembly (#1254): the core bundle/compose surface plus
 * the removable `plugins/alarm` capability the app composes. Root assembly
 * files are the one legal meeting point of core and plugin bands (#1276);
 * neither side imports the other directly.
 */
export * from "./core/compose";
export * from "./plugins/action";
export * from "./plugins/alarm";
export * from "./plugins/hook";
// #1316: dispatcher construction lives in plugins/tool; the Bundle barrel is
// the one legal meeting point that hands it to the app and the core loop.
export * from "./plugins/tool";

// #1255 S1: the three declaration contracts, surfaced for the app manifest.
// `Bundle.define` is the barrel's `define`.
export {
  Capability, defineBundle as define, Manifest, DefineRefused, CapabilityHookError, seam,
  type BundleContract, type BundleContractInput, type BundleGateRow, type BundleTool,
  type CapabilityCore, type CapabilityDefinition, type CapabilityInput,
  type CapabilityInputRow, type CapabilityKindDeclaration, type CapabilityStep,
  type ManifestDefinition, type ManifestInput, type SeamTag,
} from "./core/capability";
export { AlarmSeam } from "./core/alarm";

// #1307: the compaction capability needs the inspect band's fold/hydrate —
// an import the plugin band may not make — so THIS root assembly file wires
// the history ports into the published definition. The app lists the result
// in its manifest and composition injects its verbs as the one seam service.
export { CompactionSeam } from "./core/compaction-ports";
export type { CompactionOptions, CompactionSeamService } from "./core/compaction-ports";

import { foldSessionHistory, hydrateSessionHistory } from "./inspect/history";
import {
  compactionCapability as defineCompactionCapability,
  type CompactionHistoryPorts,
} from "./plugins/compaction";

const compactionHistoryPorts: CompactionHistoryPorts = {
  fold: foldSessionHistory,
  hydrate: hydrateSessionHistory,
};

/** The compaction capability with its history ports wired (#1307). */
export function compactionCapability() {
  return defineCompactionCapability(compactionHistoryPorts);
}
