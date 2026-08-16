import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { WorkItem } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { createRouter } from "../../src/server/routes";

const ADMIN_TOKEN = "admin-test-token";

const ADMIN_READ_PATHS = [
  "/admin/ledger/attempts",
  "/admin/ledger/streams/wait:w1/head",
  "/admin/ledger/verification",
  "/admin/ledger/archive-manifest",
] as const;

function db(): Database {
  return (Storage.getAdapter() as unknown as { readonly db: Database }).db;
}

function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.getAdapter().ledger;
  if (!ledger) throw new Error("test fixture requires the ledger sub-adapter");
  return ledger;
}

function appendFact(
  streamId: string,
  type: string,
  data: Record<string, unknown>,
  expectedHead: number,
): void {
  const outcome = requireLedger().append({ streamId, type, data }, expectedHead);
  if (outcome.kind !== "appended") throw new Error(`test fixture append conflicted: ${streamId}`);
}

function attemptIdentity(workInput: string, attemptSeq: number): WorkItem.Attempt {
  return WorkItem.Attempt.parse({
    attemptId: WorkItem.generateAttemptId(),
    attemptSeq,
    retryOf: null,
    reusedFromAttemptId: null,
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "not captured in this test" },
      model: {
        provider: "anthropic",
        id: "claude-test",
        parameters: { absent: true, reason: "no model parameters configured" },
      },
      upstreamFingerprints: {
        absent: true,
        reason: "no upstream attempts are consumed in this test",
      },
      dependencyLock: { absent: true, reason: "not read in this test" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true, reason: "no workspace in this test" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true, reason: "no policy plan in this test" },
      toolVersions: { absent: true, reason: "not enumerated in this test" },
      verifierVersions: { absent: true, reason: "not enumerated in this test" },
      providerParameters: { absent: true, reason: "no provider parameters configured" },
      configRef: { absent: true, reason: "no config identity in this test" },
    }),
  });
}

/** Mirrors the live writer: `attemptAllocatedFact` payload + injected revision at seq === revision. */
function appendAttemptFact(
  workItemHash: string,
  attempt: WorkItem.Attempt,
  revision: number,
): void {
  appendFact(
    `work:${workItemHash}`,
    "work_item.attempt_allocated",
    { ...attempt, revision },
    revision - 1,
  );
}

function authedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers ?? {}) },
  });
}

type AttemptSummary = {
  stream: string;
  seq: number;
  attemptId: string;
  attemptSeq: number;
  retryOf: string | null;
  reusedFromAttemptId: string | null;
  contentFingerprint: string;
  environmentFingerprint: string;
  timeCreated: number;
};

describe("admin ledger routes", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
  });

  test("fails closed: every route denies 401 while no admin token is configured", async () => {
    // Undefined AND empty-string tokens both fail closed. The "Bearer "
    // header is the auth-bypass regression pin: `Bearer ${""}` is exactly
    // "Bearer ", so an empty token must never authorize that header.
    for (const options of [undefined, { adminToken: "" }]) {
      const app = createRouter(undefined, options);

      for (const path of ADMIN_READ_PATHS) {
        const bare = await app.fetch(new Request(`http://localhost${path}`));
        const emptyBearer = await app.fetch(
          new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer " } }),
        );
        const withToken = await app.fetch(authedRequest(path));

        expect(bare.status).toBe(401);
        expect(await bare.json()).toEqual({ error: "Unauthorized" });
        expect(emptyBearer.status).toBe(401);
        expect(await emptyBearer.json()).toEqual({ error: "Unauthorized" });
        // No configured token means NO token is valid — not "any token works".
        expect(withToken.status).toBe(401);
        expect(await withToken.json()).toEqual({ error: "Unauthorized" });
      }
    }
  });

  test("rejects missing and wrong bearer tokens before touching storage", async () => {
    Storage.reset();
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });

    const missing = await app.fetch(new Request("http://localhost/admin/ledger/verification"));
    const wrong = await app.fetch(
      new Request("http://localhost/admin/ledger/verification", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Unauthorized" });
  });

  test("attempts: distinct attemptIds, monotonic attemptSeq, contentFingerprint digest filter", async () => {
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });
    const first = attemptIdentity("work item a", 1);
    const retry = attemptIdentity("work item a", 2);
    const other = attemptIdentity("work item b", 1);
    appendAttemptFact("hash-a", first, 1);
    appendAttemptFact("hash-a", retry, 2);
    appendAttemptFact("hash-b", other, 1);

    const all = await app.fetch(authedRequest("/admin/ledger/attempts"));
    const allBody = (await all.json()) as { attempts: AttemptSummary[] };

    expect(all.status).toBe(200);
    expect(allBody.attempts).toHaveLength(3);
    expect(new Set(allBody.attempts.map((attempt) => attempt.attemptId)).size).toBe(3);
    const streamA = allBody.attempts.filter((attempt) => attempt.stream === "work:hash-a");
    expect(streamA.map((attempt) => attempt.attemptSeq)).toEqual([1, 2]);
    expect(streamA.map((attempt) => attempt.seq)).toEqual([1, 2]);
    // Fingerprints surface as digests only — no structured inputs leak.
    expect(streamA[0]?.contentFingerprint).toBe(first.contentFingerprint.digest);

    const filtered = await app.fetch(
      authedRequest(
        `/admin/ledger/attempts?contentFingerprint=${encodeURIComponent(other.contentFingerprint.digest)}`,
      ),
    );
    const filteredBody = (await filtered.json()) as { attempts: AttemptSummary[] };

    expect(filtered.status).toBe(200);
    expect(filteredBody.attempts).toHaveLength(1);
    expect(filteredBody.attempts[0]?.attemptId).toBe(other.attemptId);

    const unmatched = await app.fetch(
      authedRequest("/admin/ledger/attempts?contentFingerprint=sha256:unmatched"),
    );

    expect(unmatched.status).toBe(200);
    expect(((await unmatched.json()) as { attempts: AttemptSummary[] }).attempts).toEqual([]);
  });

  test("attempts: the listing is bounded — limit keeps the newest facts, invalid limits are 400", async () => {
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });
    appendAttemptFact("hash-a", attemptIdentity("work item a", 1), 1);
    appendAttemptFact("hash-a", attemptIdentity("work item a", 2), 2);
    appendAttemptFact("hash-b", attemptIdentity("work item b", 1), 1);

    const limited = await app.fetch(authedRequest("/admin/ledger/attempts?limit=2"));
    const limitedBody = (await limited.json()) as { attempts: AttemptSummary[] };

    expect(limited.status).toBe(200);
    // Newest window: the oldest fact falls out first.
    expect(limitedBody.attempts).toHaveLength(2);
    expect(limitedBody.attempts.map((attempt) => attempt.stream)).toEqual([
      "work:hash-a",
      "work:hash-b",
    ]);

    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const rejected = await app.fetch(authedRequest(`/admin/ledger/attempts?limit=${bad}`));
      expect(rejected.status).toBe(400);
    }
  });

  test("stream head returns the newest recorded fact; an empty stream is 404", async () => {
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });
    appendFact("wait:w1", "wait.opened", { waitId: "w1", revision: 1 }, 0);
    appendFact("wait:w1", "wait.resolved", { waitId: "w1", revision: 2 }, 1);

    const head = await app.fetch(authedRequest("/admin/ledger/streams/wait:w1/head"));
    const headBody = (await head.json()) as {
      fact: { streamId: string; seq: number; type: string; data: Record<string, unknown> };
    };

    expect(head.status).toBe(200);
    expect(headBody.fact.streamId).toBe("wait:w1");
    expect(headBody.fact.seq).toBe(2);
    expect(headBody.fact.type).toBe("wait.resolved");

    const missing = await app.fetch(authedRequest("/admin/ledger/streams/wait:missing/head"));

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Stream is empty or unknown" });
  });

  test("verification reports an intact tail and detects a tampered row", async () => {
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });
    appendFact("wait:w1", "wait.opened", { waitId: "w1", revision: 1 }, 0);

    const intact = await app.fetch(authedRequest("/admin/ledger/verification"));
    const intactBody = (await intact.json()) as { intact: boolean; breaks: unknown[] };

    expect(intact.status).toBe(200);
    expect(intactBody.intact).toBe(true);
    expect(intactBody.breaks).toEqual([]);

    db()
      .query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = ?")
      .run(JSON.stringify({ waitId: "tampered" }), "wait:w1", 1);

    const broken = await app.fetch(authedRequest("/admin/ledger/verification"));
    const brokenBody = (await broken.json()) as {
      intact: boolean;
      breaks: Array<{ streamId: string; seq: number; code: string }>;
    };

    expect(broken.status).toBe(200);
    expect(brokenBody.intact).toBe(false);
    expect(brokenBody.breaks).toContainEqual(
      expect.objectContaining({ streamId: "wait:w1", seq: 1, code: "hash_mismatch" }),
    );
  });

  test("archive manifest serves the generated artifact and 404s while none exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "admin-ledger-manifest-"));
    try {
      const manifestPath = join(tempDir, "ledger-archive-manifest.json");
      const manifest = {
        manifestVersion: 1,
        generatedAt: 1723180800000,
        tables: [
          {
            table: "pending_ask",
            sourceSchemaVersion: "0013_ledger/migration.sql",
            rowCount: 0,
            idRange: null,
            integrityHash:
              "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        ],
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const app = createRouter(undefined, {
        adminToken: ADMIN_TOKEN,
        ledgerArchiveManifestPath: manifestPath,
      });

      const served = await app.fetch(authedRequest("/admin/ledger/archive-manifest"));

      expect(served.status).toBe(200);
      expect(await served.json()).toEqual(manifest);

      const absent = await createRouter(undefined, {
        adminToken: ADMIN_TOKEN,
        ledgerArchiveManifestPath: join(tempDir, "never-generated.json"),
      }).fetch(authedRequest("/admin/ledger/archive-manifest"));

      expect(absent.status).toBe(404);
      expect(await absent.json()).toEqual({ error: "Archive manifest not generated" });

      const unconfiguredPath = await createRouter(undefined, { adminToken: ADMIN_TOKEN }).fetch(
        authedRequest("/admin/ledger/archive-manifest"),
      );

      expect(unconfiguredPath.status).toBe(404);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("read-only pin: no mutating route exists and every read succeeds on a write-refusing adapter", async () => {
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });
    appendAttemptFact("hash-a", attemptIdentity("work item a", 1), 1);
    appendFact("wait:w1", "wait.opened", { waitId: "w1", revision: 1 }, 0);
    const eventCount = () =>
      (db().query("SELECT COUNT(*) AS count FROM ledger_event").get() as { count: number }).count;
    const before = eventCount();

    // Swap in an adapter whose ONLY working ledger surface is the read API:
    // any append or storage transaction is a loud read-only violation.
    const adapter = Storage.getAdapter();
    const ledger = requireLedger();
    Storage.configure({
      ...adapter,
      transaction: () => {
        throw new Error("read-only violation: admin surface opened a storage transaction");
      },
      ledger: {
        headFact: (streamId) => ledger.headFact(streamId),
        factsByType: (type) => ledger.factsByType(type),
        verifyTail: () => ledger.verifyTail(),
        append: () => {
          throw new Error("read-only violation: admin surface appended to the ledger");
        },
        adoptStream: () => {
          throw new Error("read-only violation: admin surface adopted a ledger stream");
        },
      },
    });

    const responses = await Promise.all(
      ADMIN_READ_PATHS.map((path) => app.fetch(authedRequest(path))),
    );

    // 503 would mean a handler hit the throwing write path; 404s here are the
    // expected empty-resource answers (unknown stream head, no manifest).
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 404]);

    // The issue's Manual QA scenario driver (POST /admin/ledger/scenarios)
    // is deliberately NOT part of this surface: D3 ships read-only
    // inspection; scenario matrices stay Verification-only conformance.
    const mutations = await Promise.all([
      app.fetch(authedRequest("/admin/ledger/scenarios", { method: "POST", body: "{}" })),
      app.fetch(authedRequest("/admin/ledger/attempts", { method: "POST", body: "{}" })),
      app.fetch(authedRequest("/admin/ledger/streams/wait:w1/head", { method: "DELETE" })),
    ]);

    expect(mutations.map((res) => res.status)).toEqual([404, 404, 404]);
    expect(eventCount()).toBe(before);
  });
});
