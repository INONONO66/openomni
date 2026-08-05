import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import type { CompletionAuthorityDependencies } from "./completion-admission-authority.js";
import { createCompletionAuthorityResolver } from "./completion-admission-authority.js";
import {
  type CompletionAdmissionService,
  createCompletionAdmissionService,
} from "./completion-admission-boundary.js";

export type WorkItemCompletionGatewayOptions = CompletionAuthorityDependencies &
  Readonly<{ completionWriter: Storage.WorkItemCompletionWriter }>;
export type WorkItemCompletionRecoveryReceipt = Readonly<{
  recovered: number;
  skipped: number;
  failures: readonly Readonly<{
    workItemHash: string;
    admissionId: string;
    error: string;
  }>[];
}>;
export type WorkItemCompletionGateway = CompletionAdmissionService &
  Readonly<{
    recoverRecordedCompletions(): Promise<WorkItemCompletionRecoveryReceipt>;
  }>;

export function createWorkItemCompletionGateway(
  options: WorkItemCompletionGatewayOptions,
): WorkItemCompletionGateway {
  const now = options.now ?? Date.now;
  const service = createCompletionAdmissionService({
    completionWriter: options.completionWriter,
    authorityResolver: createCompletionAuthorityResolver(options),
    allowTrustedInvalidations: options.invalidationAuthorityPort !== undefined,
    now,
  });
  return Object.freeze({
    ...service,
    async recoverRecordedCompletions() {
      const adapter = Storage.get().workItem;
      if (!adapter) return { recovered: 0, skipped: 0, failures: [] };
      let recovered = 0;
      let skipped = 0;
      const failures: Array<{
        workItemHash: string;
        admissionId: string;
        error: string;
      }> = [];
      for (const item of adapter.list()) {
        if (item.completionTerminalReceipt) {
          continue;
        }
        if (item.completionFacts.admissions.length === 0) {
          const reservation = item.completionFacts.requestReservations
            .filter(({ attempt, basisRef }) => {
              return attempt === item.attempt && basisRef === item.completionContract.basisRef;
            })
            .at(-1);
          if (!reservation) continue;
          const recoveredAt = now();
          if (
            reservation.leaseExpiresAt !== undefined &&
            reservation.leaseExpiresAt > recoveredAt
          ) {
            const released = releasePreAdmissionReservation(
              item,
              reservation,
              recoveredAt,
              options.completionWriter,
            );
            if (!released) {
              failures.push({
                workItemHash: item.hash,
                admissionId: reservation.id,
                error: "completion reservation release lost row CAS",
              });
              continue;
            }
          }
          skipped += 1;
          continue;
        }
        const admission = item.completionFacts.admissions
          .filter(
            (candidate) =>
              candidate.contractRevision === item.completionContract.revision &&
              candidate.basisRef === item.completionContract.basisRef,
          )
          .at(-1);
        if (
          !admission ||
          ["completed", "failed", "cancelled"].includes(WorkItem.deriveStatus(item))
        ) {
          skipped += 1;
          continue;
        }
        if (
          item.blockers.some(
            (blocker) => !blocker.resolvedAt && blocker.id === `${admission.id}:recovery-blocker`,
          )
        ) {
          skipped += 1;
          continue;
        }
        try {
          if (admission.decision === "block" || admission.decision === "escalate") {
            const description = `completion admission ${admission.decision}: ${admission.reasonCodes.join(", ")}`;
            if (
              item.blockers.some(
                (blocker) => !blocker.resolvedAt && blocker.description === description,
              )
            ) {
              skipped += 1;
              continue;
            }
            if (
              item.revision !== admission.recordedHead &&
              admission.completionReportSnapshot !== undefined
            ) {
              const reevaluated = await service.resumeCompletion(
                item.hash,
                admission.id,
                admission.completionReportSnapshot,
              );
              if (WorkItem.deriveStatus(reevaluated) === "completed") {
                recovered += 1;
                continue;
              }
              const latestAdmission = reevaluated.completionFacts.admissions
                .filter(
                  (candidate) =>
                    candidate.contractRevision === reevaluated.completionContract.revision &&
                    candidate.basisRef === reevaluated.completionContract.basisRef,
                )
                .at(-1);
              if (
                latestAdmission &&
                (latestAdmission.decision === "block" || latestAdmission.decision === "escalate") &&
                (await materializeAdmissionBlocker(item.hash, latestAdmission))
              ) {
                recovered += 1;
                continue;
              }
              throw new Error("completion recovery remained incomplete");
            }
            if (!(await materializeAdmissionBlocker(item.hash, admission))) {
              skipped += 1;
              continue;
            }
            recovered += 1;
            continue;
          }
          if (
            (admission.decision !== "admit" && admission.decision !== "owner_override") ||
            admission.completionReportSnapshot === undefined
          ) {
            skipped += 1;
            continue;
          }
          const recoveredItem = await service.resumeCompletion(
            item.hash,
            admission.id,
            admission.completionReportSnapshot,
          );
          if (WorkItem.deriveStatus(recoveredItem) === "completed") {
            recovered += 1;
          } else {
            const latestAdmission = recoveredItem.completionFacts.admissions
              .filter(
                (candidate) =>
                  candidate.contractRevision === recoveredItem.completionContract.revision &&
                  candidate.basisRef === recoveredItem.completionContract.basisRef,
              )
              .at(-1);
            if (
              latestAdmission &&
              (latestAdmission.decision === "block" || latestAdmission.decision === "escalate") &&
              (await materializeAdmissionBlocker(item.hash, latestAdmission))
            ) {
              recovered += 1;
            } else {
              failures.push({
                workItemHash: item.hash,
                admissionId: admission.id,
                error: "completion recovery remained incomplete",
              });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message.startsWith("completion report ") ||
            message.startsWith("completion terminal ")
          ) {
            if (await materializeRecoveryErrorBlocker(item.hash, admission, message)) {
              recovered += 1;
            } else {
              skipped += 1;
            }
            continue;
          }
          failures.push({
            workItemHash: item.hash,
            admissionId: admission.id,
            error: message,
          });
        }
      }
      return { recovered, skipped, failures };
    },
  });
}

function releasePreAdmissionReservation(
  item: WorkItem.Info,
  reservation: WorkItem.CompletionRequestReservation,
  releasedAt: number,
  completionWriter: Storage.WorkItemCompletionWriter,
): boolean {
  const candidate = WorkItem.Info.parse({
    ...item,
    revision: item.revision + 1,
    completionFacts: {
      ...item.completionFacts,
      revision: item.completionFacts.revision + 1,
      requestReservations: item.completionFacts.requestReservations.map((current) =>
        current.id === reservation.id
          ? {
              ...current,
              leaseExpiresAt:
                current.leaseExpiresAt === undefined
                  ? releasedAt
                  : Math.min(current.leaseExpiresAt, releasedAt),
            }
          : current,
      ),
    },
    timestamps: { ...item.timestamps, updated: Math.max(item.timestamps.updated, releasedAt) },
  });
  return completionWriter(item.hash, item.revision, candidate);
}

async function materializeAdmissionBlocker(
  workItemHash: string,
  admission: WorkItem.CompletionAdmission,
): Promise<boolean> {
  const description = `completion admission ${admission.decision}: ${admission.reasonCodes.join(", ")}`;
  const current = WorkItemStore.get(workItemHash);
  if (
    current?.blockers.some((blocker) => !blocker.resolvedAt && blocker.description === description)
  ) {
    return false;
  }
  await WorkItemStore.addBlocker(workItemHash, {
    id: `${admission.id}:blocker`,
    description,
    kind: "error",
  });
  return true;
}

async function materializeRecoveryErrorBlocker(
  workItemHash: string,
  admission: WorkItem.CompletionAdmission,
  error: string,
): Promise<boolean> {
  const description = `completion recovery blocked: ${error}`;
  const current = WorkItemStore.get(workItemHash);
  if (
    current?.blockers.some((blocker) => !blocker.resolvedAt && blocker.description === description)
  ) {
    return false;
  }
  await WorkItemStore.addBlocker(workItemHash, {
    id: `${admission.id}:recovery-blocker`,
    description,
    kind: "error",
  });
  return true;
}
