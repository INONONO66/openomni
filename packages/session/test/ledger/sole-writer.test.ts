import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@openomni/protocol";
import { LedgerQueryCapabilityClosedError, type LedgerQuery } from "../../src/ledger/query.js";
import {
  LedgerRuntimeAppendCancelledError,
  LedgerRuntimeAsyncQueryError,
  LedgerRuntimeClosedError,
  LedgerRuntimePathInUseError,
  LedgerRuntimeQueueFullError,
  openLedgerRuntime,
} from "../../src/ledger/runtime.js";
import { appendBatch, event, owner } from "./fixture.js";
function sessionSnapshot(id: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: "session-projection-state-v1", state: { id: `event-${id}` } }),
  );
  const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  return { bytes, expectedHash };
}

function appendOptions(id: string, signal?: AbortSignal) {
  return {
    artifactBlobs: [sessionSnapshot(id)],
    ...(signal === undefined ? {} : { signal }),
  };
}

function temporaryLedgerPath(): { readonly path: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), "openomni-ledger-runtime-"));
  return {
    path: join(directory, "ledger.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function independentBatch(id: string, principalId = "principal-a"): Ledger.AppendBatch {
  const ownerRef = owner(`owner-${id}`);
  const baseEvent = event(`event-${id}`, ownerRef);
  const snapshot = sessionSnapshot(id);
  const admittedEvent = Ledger.EventV1.parse({
    ...baseEvent,
    payload: {
      ...baseEvent.payload,
      sessionSnapshotRef: {
        version: "content-blob-ref-v1",
        digest: snapshot.expectedHash.slice("sha256:".length),
        byteLength: snapshot.bytes.byteLength,
        mediaType: "application/json",
      },
    },
  });
  return appendBatch({
    requestId: `request-${id}`,
    batchId: `batch-${id}`,
    principalId,
    owner: ownerRef,
    events: [admittedEvent],
  });
}

describe("ledger runtime sole-writer contract", () => {
  test("denies alias and second-connection writers until the runtime closes", async () => {
    const temporary = temporaryLedgerPath();
    const aliasPath = `${temporary.path}.alias`;
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    expect(Object.keys(runtime).sort()).toEqual(["append", "close", "query", "readBlob"]);
    try {
      symlinkSync(temporary.path, aliasPath);
      expect(() => openLedgerRuntime({ dbPath: aliasPath })).toThrow(LedgerRuntimePathInUseError);

      const competing = new Database(temporary.path, { strict: true });
      try {
        competing.query("PRAGMA busy_timeout = 0").get();
        expect(() => competing.exec("BEGIN IMMEDIATE TRANSACTION")).toThrow(/locked/);
      } finally {
        competing.close();
      }

      await runtime.close();
      const reopened = openLedgerRuntime({ dbPath: temporary.path });
      await reopened.close();
    } finally {
      await runtime.close();
      temporary.cleanup();
    }
  });

  test("serializes appends and preserves per-principal FIFO with round-robin fairness", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    try {
      const a1 = runtime.append(independentBatch("a-1", "principal-a"), appendOptions("a-1"));
      const a2 = runtime.append(independentBatch("a-2", "principal-a"), appendOptions("a-2"));
      const b1 = runtime.append(independentBatch("b-1", "principal-b"), appendOptions("b-1"));
      await Promise.all([a1, a2, b1]);
      expect(
        await runtime.query((query) =>
          query
            .eventsByLedgerSequence({ throughLedgerSeq: 3 })
            .map((envelope) => envelope.event.eventId),
        ),
      ).toEqual(["event-a-1", "event-b-1", "event-a-2"]);
    } finally {
      await runtime.close();
      temporary.cleanup();
    }
  });

  test("enforces 64 queued appends per principal", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    const queued = Array.from({ length: 64 }, (_, index) =>
      runtime
        .append(independentBatch(`principal-cap-${index}`), appendOptions(`principal-cap-${index}`))
        .catch((error) => error),
    );
    try {
      const overflow = runtime.append(
        independentBatch("principal-overflow"),
        appendOptions("principal-overflow"),
      );
      await expect(overflow).rejects.toBeInstanceOf(LedgerRuntimeQueueFullError);
      await expect(overflow).rejects.toMatchObject({
        code: "ledger_runtime_queue_full",
        scope: "principal",
        limit: 64,
      });
    } finally {
      await runtime.close();
      await Promise.all(queued);
      temporary.cleanup();
    }
  });

  test("enforces 1024 queued appends in total", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    const queued: Promise<unknown>[] = [];
    for (let principal = 0; principal < 16; principal += 1) {
      for (let index = 0; index < 64; index += 1) {
        queued.push(
          runtime
            .append(
              independentBatch(`total-${principal}-${index}`, `principal-${principal}`),
              appendOptions(`total-${principal}-${index}`),
            )
            .catch((error) => error),
        );
      }
    }
    try {
      const overflow = runtime.append(
        independentBatch("total-overflow", "principal-overflow"),
        appendOptions("total-overflow"),
      );
      await expect(overflow).rejects.toBeInstanceOf(LedgerRuntimeQueueFullError);
      await expect(overflow).rejects.toMatchObject({
        code: "ledger_runtime_queue_full",
        scope: "total",
        limit: 1_024,
      });
    } finally {
      await runtime.close();
      await Promise.all(queued);
      temporary.cleanup();
    }
  });

  test("cancels only before dequeue and writes nothing for the cancelled request", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    try {
      const controller = new AbortController();
      const append = runtime.append(
        independentBatch("cancelled"),
        appendOptions("cancelled", controller.signal),
      );
      controller.abort();
      await expect(append).rejects.toBeInstanceOf(LedgerRuntimeAppendCancelledError);
      expect(
        await runtime.query((query) => query.appendResult("request-cancelled")),
      ).toBeUndefined();
    } finally {
      await runtime.close();
      temporary.cleanup();
    }
  });

  test("copies queued artifact arrays and bytes at append admission", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    const originalBytes = Uint8Array.from([1, 2, 3, 4]);
    const expectedHash =
      `sha256:${createHash("sha256").update(originalBytes).digest("hex")}` as const;
    const snapshot = sessionSnapshot("immutable-options");
    const artifactBlobs = [snapshot, { bytes: originalBytes, expectedHash }];
    try {
      const append = runtime.append(independentBatch("immutable-options"), { artifactBlobs });
      originalBytes.fill(9);
      artifactBlobs.splice(0, artifactBlobs.length);

      await append;
      expect((await runtime.readBlob(expectedHash))?.bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
    } finally {
      await runtime.close();
      temporary.cleanup();
    }
  });

  test("close rejects queued and post-close work without writing", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    const queued = runtime.append(
      independentBatch("closed-before-dequeue"),
      appendOptions("closed-before-dequeue"),
    );
    const closing = runtime.close();
    await expect(queued).rejects.toBeInstanceOf(LedgerRuntimeClosedError);
    await closing;
    await expect(
      runtime.append(independentBatch("post-close"), appendOptions("post-close")),
    ).rejects.toBeInstanceOf(LedgerRuntimeClosedError);
    await expect(runtime.query((query) => query.head(owner()))).rejects.toBeInstanceOf(
      LedgerRuntimeClosedError,
    );
    await expect(runtime.readBlob(`sha256:${"0".repeat(64)}`)).rejects.toBeInstanceOf(
      LedgerRuntimeClosedError,
    );
    temporary.cleanup();
  });

  test("expires query capabilities and rejects async callbacks", async () => {
    const temporary = temporaryLedgerPath();
    const runtime = openLedgerRuntime({ dbPath: temporary.path });
    try {
      let retained: LedgerQuery | undefined;
      await runtime.query((query) => {
        retained = query;
        return query.head(owner());
      });
      expect(() => retained?.head(owner())).toThrow(LedgerQueryCapabilityClosedError);
      await expect(runtime.query(async (query) => query.head(owner()))).rejects.toBeInstanceOf(
        LedgerRuntimeAsyncQueryError,
      );
    } finally {
      await runtime.close();
      temporary.cleanup();
    }
  });
});
