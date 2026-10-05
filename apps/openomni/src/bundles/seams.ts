import { Bundle } from "@openomni/agent";

/**
 * App-owned capability seams (#1255/#1258), declared outside `manifest.ts` so
 * bundles can require them without importing the manifest that lists the
 * bundles (no cycle). The manifest's `Capability.define` contracts carry
 * these exact tags.
 */

/** The tool capability's seam; `bundles/send-message` requires it. */
export const ToolCapabilitySeam = Bundle.seam("@openomni/openomni/ToolCapabilitySeam");

/**
 * The action capability's seam (#1256/#1258): the capability that registers
 * the `action` deliver input (the nudge). The hook capability requires
 * "action" by NAME and `bundles/delegation-policy` requires this seam, so
 * turning `action` off cascades hooks and the policy bundle off with it.
 */
export const ActionCapabilitySeam = Bundle.seam("@openomni/openomni/ActionCapabilitySeam");
