import type { CapabilityId, Enrollment, ExportName, MachineId, Offer } from "./schema.js";

export type EffectiveOutcome =
  | {
      /** The capability set every placement/authorization decision reads. */
      kind: "effective";
      machineId: MachineId;
      /** enrollment ∩ offer — deduped and sorted here, for stable comparison. */
      capabilities: readonly CapabilityId[];
    }
  | {
      /** An offer for a different machine never intersects — it refuses. */
      kind: "machine_mismatch";
      enrolled: MachineId;
      offered: MachineId;
    };

/**
 * effective = enrollment ∩ offer (docs/machines-and-delegation.md §2).
 * Pure and clockless: the Owner's allowlist caps what the daemon claims,
 * so neither side can grant itself a capability the other never named.
 */
export function effectiveCapabilities(enrollment: Enrollment, offer: Offer): EffectiveOutcome {
  if (enrollment.machineId !== offer.machineId) {
    return {
      kind: "machine_mismatch",
      enrolled: enrollment.machineId,
      offered: offer.machineId,
    };
  }
  const allowed = new Set(enrollment.allowedCapabilities);
  return {
    kind: "effective",
    machineId: enrollment.machineId,
    capabilities: [...new Set(offer.offeredCapabilities.filter((id) => allowed.has(id)))].sort(),
  };
}

export type EffectiveExportsOutcome =
  | {
      /** The negotiated confinement-root identifiers. */
      kind: "effective";
      machineId: MachineId;
      /** enrollment ∩ offer — deduped and sorted here, for stable comparison. */
      exports: readonly ExportName[];
    }
  | {
      kind: "machine_mismatch";
      enrolled: MachineId;
      offered: MachineId;
    };

/**
 * effective = enrollment ∩ offer, the same fold as capabilities but over export
 * names. Both sides are optional on the wire and BOTH default to empty: an
 * enrollment that names no export publishes nothing, and a daemon that offers
 * none serves nothing. No implicit filesystem authority is granted.
 */
export function effectiveExports(enrollment: Enrollment, offer: Offer): EffectiveExportsOutcome {
  if (enrollment.machineId !== offer.machineId) {
    return {
      kind: "machine_mismatch",
      enrolled: enrollment.machineId,
      offered: offer.machineId,
    };
  }
  const allowed = new Set(enrollment.allowedExports ?? []);
  return {
    kind: "effective",
    machineId: enrollment.machineId,
    exports: [
      ...new Set(
        (offer.exports ?? []).map((entry) => entry.name).filter((name) => allowed.has(name)),
      ),
    ].sort(),
  };
}
