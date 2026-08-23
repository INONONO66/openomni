import { Storage, WorkItemStore } from "@openomni/ledger";
import { assembleProjectionInput } from "./assembler";
import {
  FLAT_EVENT_FIELDS,
  foldToFlatEvents,
  type FlatEvent,
} from "./flat-event";
import type { SidecarStore } from "./sidecar-store";

export type ProjectionExport = {
  workItemId: string;
  rows: FlatEvent[];
  jsonl: string;
  sidecarDigests: string[];
};

export type ProjectionExportErrorReason = "work_item_not_found";

export class ProjectionExportError extends Error {
  readonly name = "ProjectionExportError";

  constructor(
    readonly reason: ProjectionExportErrorReason,
    readonly workItemId: string,
  ) {
    super(`projection export failed: ${reason}: ${workItemId}`);
  }
}

function serializeRows(rows: FlatEvent[]): string {
  if (rows.length === 0) return "";
  return `${rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(
          FLAT_EVENT_FIELDS.map((field) => [field, row[field]]),
        ),
      ),
    )
    .join("\n")}\n`;
}

export function exportWorkItemProjection(
  workItemId: string,
  sidecar: SidecarStore,
): ProjectionExport {
  const workItem = WorkItemStore.get(workItemId);
  if (workItem === undefined) {
    throw new ProjectionExportError("work_item_not_found", workItemId);
  }

  const adapter = Storage.getAdapter();
  const ledger = adapter.ledger;
  if (ledger === undefined)
    throw new Error("storage adapter does not implement ledger reads");
  const ownerStream = `work:${workItemId}`;
  const allocationFacts = ledger.factsByType("work_item.attempt_allocated");
  const attemptFacts = [
    ...allocationFacts,
    ...ledger.factsByType("work_item.attempt_finished"),
  ].filter((fact) => fact.streamId === ownerStream);
  const siblingStreams = new Set(
    workItem.sessionId === undefined
      ? []
      : WorkItemStore.list({ sessionId: workItem.sessionId })
          .filter((item) => item.workItemId !== workItemId)
          .map((item) => `work:${item.workItemId}`),
  );
  const siblingAllocationFacts = allocationFacts.filter((fact) =>
    siblingStreams.has(fact.streamId),
  );
  const transcriptRows =
    workItem.sessionId === undefined
      ? []
      : (() => {
          const transcriptFact = adapter.transcriptFact;
          if (transcriptFact === undefined) {
            throw new Error(
              "storage adapter does not implement transcript fact reads",
            );
          }
          return transcriptFact.list(workItem.sessionId);
        })();
  const rows = foldToFlatEvents(
    assembleProjectionInput(
      { workItem, attemptFacts, siblingAllocationFacts, transcriptRows },
      sidecar,
    ),
  );
  const sidecarDigests = [
    ...new Set(
      rows.flatMap((row) =>
        row.observation_hash === null ? [] : [row.observation_hash],
      ),
    ),
  ].sort();

  return {
    workItemId,
    rows,
    jsonl: serializeRows(rows),
    sidecarDigests,
  };
}
