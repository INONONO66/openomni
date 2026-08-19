import { Channel } from "../channel/index.js";
import type { Ingress } from "./index.js";
import { resolveTarget, targetKey } from "./target.js";

/**
 * THE surface-key map key for an inbound event (#707 stage-2 hoist from the
 * kernel session resolver). Pure fold over protocol vocabulary — both the
 * gateway router (external claim, record-before-act) and the brain (internal
 * cron/dispatch surface sessions) derive the SAME byte-frozen key from the
 * same event shape, so the persisted surface↔session rows can never fork by
 * copy drift.
 *
 * Format: "surface:workspace:channel" for legacy events. Explicit ADR-008
 * targets append `target:<target-key>` so resident and worker sessions do
 * not collide.
 */
export function extractSurfaceKey(event: {
  surface: string;
  workspace?: string;
  channel?: string;
  target?: Ingress.Target;
  meta?: Ingress.Meta;
}): string {
  const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
  const target = event.target || event.meta?.target ? resolveTarget(event) : undefined;
  if (target && target.kind !== "resident") {
    parts.push("target", targetKey(target));
  }
  return Channel.SurfaceKey.create(parts);
}
