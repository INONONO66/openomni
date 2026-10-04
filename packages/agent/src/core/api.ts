// The single import target for capability plugins (#1276): re-exports exactly
// the core ports and types `plugins/compaction` consumes today. #1255 grows
// this into the core context handed to loaded capabilities.
export type { ExecutionRequest, Executor } from "./gate/decide";
export {
  AgentFailure, AgentInvariantViolation, CompactionExecutionError, ContextRestoreError,
  type ExecutionError, pretty,
} from "./failure";
export type { SessionKernel } from "./entity";
export { Entropy } from "./ports";
export { RunEvents } from "./run-events";
// #1254 alarm seam: exactly what an alarm capability needs; frozen at S1 —
// later steps add, never rename.
export {
  ArmRefused, AlarmWakeError, RESERVED_PURPOSES,
  type AlarmCapability, type AlarmWakeContext, type ArmVerb, type AlarmFired, type AlarmWakeOutcome,
} from "./alarm";
// #1255 S1 declaration contracts (frozen: later steps add, never rename):
// `Capability.define` / `Bundle.define` (`defineBundle`) / `Manifest.define`.
export {
  Capability, defineBundle, Manifest, DefineRefused, CapabilityHookError,
  type BundleContract, type BundleContractInput, type BundleGateRow, type BundleTool,
  type CapabilityCore, type CapabilityDefinition, type CapabilityInput,
  type CapabilityInputRow, type CapabilityKindDeclaration, type CapabilityStep,
  type ManifestDefinition, type ManifestInput, type SeamTag,
} from "./capability";
export { AlarmSeam } from "./alarm";
