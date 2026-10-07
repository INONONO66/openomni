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
