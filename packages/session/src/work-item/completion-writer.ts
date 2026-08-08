import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkItem } from "@openomni/protocol";
import type { Storage } from "../storage/storage.js";
import { appendTransitionFactReceipt, requireWorkItemLedger, type WorkItemFact } from "./facts.js";

const writerAuthority = Symbol("work-item-completion-writer");
const authorizedWriter = new AsyncLocalStorage<symbol>();

/**
 * #510 C1 — the admission service's record-before-terminal seam. Every
 * completion-authority write (request reservation, reservation release,
 * admission verdict, terminal commit) flows through this writer, and each
 * appends its decision-class fact on `work:<hash>` BEFORE the projection CAS
 * inside one sync immediate storage transaction. The verdict facts are
 * work_item.admission_accepted (admit / owner_override) and
 * work_item.admission_refused (block / escalate) — accept AND refuse are
 * both durable facts; only fold-level rejections that never write stay
 * unrecorded. A stale head returns false (nothing written) so the fold's
 * existing retry-from-new-head loops keep their contract.
 */
export function createWorkItemCompletionWriter(
  getStorage: () => Pick<Storage.Adapter, "transaction" | "workItem" | "ledger">,
): Storage.WorkItemCompletionWriter {
  return (hash, expectedHead, item) => {
    const storage = getStorage();
    const adapter = storage.workItem;
    if (!adapter) throw new Error("WorkItem storage is unavailable");
    const ledger = requireWorkItemLedger(storage);
    return authorizedWriter.run(writerAuthority, () =>
      storage.transaction(() => {
        const existing = adapter.get(hash);
        if (!existing || existing.revision !== expectedHead) return false;
        if (!appendTransitionFactReceipt(ledger, existing, completionFactOf(existing, item))) {
          return false;
        }
        return adapter.compareAndSet(hash, expectedHead, item);
      }),
    );
  };
}

export function isAuthorizedCompletionWriter(): boolean {
  return authorizedWriter.getStore() === writerAuthority;
}

// The fold stays unrestructured: each write kind is classified from what the
// candidate row appends over the durable row (the same diff discipline the
// adapter's append-only assertions already apply). A write that matches no
// completion transition still appends a work_item.updated fact naming its
// changed fields — the adapter's append-only/authority assertions then
// refuse tampered shapes inside the same transaction, rolling the fact back.
function completionFactOf(existing: WorkItem.Info, next: WorkItem.Info): WorkItemFact {
  if (next.completionTerminalReceipt && !existing.completionTerminalReceipt) {
    const receipt = next.completionTerminalReceipt;
    return {
      type: "work_item.completed",
      data: {
        requestId: receipt.requestId,
        admissionId: receipt.admissionId,
        contractRevision: receipt.contractRevision,
        basisRef: receipt.basisRef,
        completionReportRef: receipt.completionReportRef,
      },
    };
  }
  const admissions = next.completionFacts.admissions;
  if (admissions.length > existing.completionFacts.admissions.length) {
    const admission = admissions.at(-1);
    if (!admission) throw new Error(`WorkItem admission write appended nothing: ${next.hash}`);
    const accepted = admission.decision === "admit" || admission.decision === "owner_override";
    return {
      type: accepted ? "work_item.admission_accepted" : "work_item.admission_refused",
      data: {
        admissionId: admission.id,
        requestId: admission.requestId,
        decision: admission.decision,
        reasonCodes: admission.reasonCodes,
        unresolvedCriterionIds: admission.unresolvedCriterionIds,
        contractRevision: admission.contractRevision,
        basisRef: admission.basisRef,
      },
    };
  }
  const reservations = next.completionFacts.requestReservations;
  if (reservations.length > existing.completionFacts.requestReservations.length) {
    const reservation = reservations.at(-1);
    if (!reservation) throw new Error(`WorkItem reservation write appended nothing: ${next.hash}`);
    const released =
      reservation.leaseExpiresAt !== undefined &&
      reservation.leaseExpiresAt <= reservation.createdAt;
    return {
      type: released
        ? "work_item.completion_reservation_released"
        : "work_item.completion_request_reserved",
      data: {
        reservationId: reservation.id,
        requestId: reservation.requestId,
        fence: reservation.fence,
        ...(reservation.ownerId === undefined ? {} : { ownerId: reservation.ownerId }),
        ...(reservation.leaseExpiresAt === undefined
          ? {}
          : { leaseExpiresAt: reservation.leaseExpiresAt }),
      },
    };
  }
  return { type: "work_item.updated", data: { fields: changedFieldsOf(existing, next) } };
}

function changedFieldsOf(existing: WorkItem.Info, next: WorkItem.Info): string[] {
  const previous = existing as Record<string, unknown>;
  const candidate = next as Record<string, unknown>;
  return [...new Set([...Object.keys(previous), ...Object.keys(candidate)])]
    .filter((key) => key !== "revision")
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(candidate[key]))
    .sort();
}
