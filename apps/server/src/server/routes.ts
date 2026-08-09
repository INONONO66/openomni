import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import {
  type LedgerAppend,
  Operational,
  type Storage as ProtocolStorage,
  WorkItem,
} from "@openomni/protocol";
import { Bus, BusQuery, Storage } from "@openomni/session";

type Env = { Variables: { requestId: string } };

type EventSummary = {
  eventType: string;
  traceId: string;
  timeCreated: number;
};

/**
 * Constant-time bearer check (#510 review fix minor): `timingSafeEqual`
 * refuses unequal-length buffers, so the length guard rejects first — the
 * length itself leaks (unavoidable with any string compare) but no byte
 * content does. Both authenticated read surfaces (observability + admin
 * ledger) share this one owner.
 */
function bearerAuthorized(header: string | undefined, token: string): boolean {
  // Fail closed on a missing/empty token: `Bearer ${""}` is the 7-byte string
  // "Bearer ", which a header of exactly "Bearer " would match — an
  // unconfigured surface must never authorize anything.
  if (!token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(header ?? "");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

type RouterOptions = {
  observabilityToken?: string;
  /**
   * Bearer token for the #510 D3 `/admin/ledger/*` read surface
   * (`OPENOMNI_ADMIN_TOKEN` / `server.adminToken`). The routes are ALWAYS
   * registered and fail closed: while no token is configured every request
   * is denied 401 — an unconfigured admin surface must never look open.
   */
  adminToken?: string;
  /** Durable archive-manifest artifact (D2a convention: `ledger-archive-manifest.json` beside the database file). */
  ledgerArchiveManifestPath?: string;
};

export function createRouter(
  githubWebhookHandler?: (req: Request) => Promise<Response>,
  options: RouterOptions = {},
): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", cors({ origin: "*" }));

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
  });

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const duration = Math.round(performance.now() - start);
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "http request",
      context: {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: duration,
        requestId: c.get("requestId"),
      },
    });
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      timestamp: new Date().toISOString(),
    }),
  );

  // Always registered, fails closed while unconfigured (same convention as
  // the admin ledger surface): no observability token means every request is
  // denied 401 — never "route absent", and never "empty token matches".
  app.get("/observability/sessions/:sessionId/events", async (c) => {
    const token = options.observabilityToken;
    if (!token || !bearerAuthorized(c.req.header("Authorization"), token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const sessionId = c.req.param("sessionId");
    try {
      const [stats, errors, workerRuns, chainIntegrity] = await Promise.all([
        BusQuery.getStats(sessionId),
        BusQuery.listErrors(sessionId),
        BusQuery.getWorkerRunHistory(sessionId),
        BusQuery.verifyChainIntegrity(sessionId),
      ]);
      return c.json({
        sessionId,
        stats,
        errors: errors.map(toEventSummary),
        workerRuns,
        chainIntegrity,
      });
    } catch (error) {
      Bus.publish(Operational.Error, {
        traceId: c.get("requestId"),
        time: Date.now(),
        component: "server",
        msg: "observability query failed",
        error: error instanceof Error ? error.message : String(error),
        context: { sessionId },
      });
      return c.json(
        {
          error: "Observability query unavailable",
        },
        503,
      );
    }
  });

  registerAdminLedgerRoutes(app, options);

  if (githubWebhookHandler) {
    app.post("/github/webhook", async (c) => githubWebhookHandler(c.req.raw));
  }

  return app;
}

/**
 * #510 D3 — authenticated READ-ONLY ledger inspection (`/admin/ledger/*`).
 * Every route is a GET over the append core's read APIs (headFact /
 * factsByType / verifyTail) or the D2a archive-manifest artifact; nothing
 * here appends to the ledger or mutates state (pinned by
 * `apps/server/test/server/admin-ledger.test.ts`). Auth follows the existing
 * bearer convention (see the observability route) but fails closed while
 * unconfigured instead of not registering.
 */
function registerAdminLedgerRoutes(app: Hono<Env>, options: RouterOptions): void {
  app.use("/admin/*", async (c, next) => {
    const token = options.adminToken;
    if (!token || !bearerAuthorized(c.req.header("Authorization"), token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  // Issue #510 Manual QA: attempt-identity history — distinct attemptIds,
  // monotonic attemptSeq per work stream, optionally filtered by content
  // fingerprint digest. Fingerprints are reported as digests only. The
  // result set is BOUNDED (`limit`, newest last, default/cap below): the
  // fact history grows without bound and each row pays a full
  // WorkItem.Attempt.parse, so the digest filter runs on the raw fact and
  // the parse runs only on the returned window.
  app.get("/admin/ledger/attempts", (c) =>
    respondWithLedgerRead(c, () => {
      const contentFingerprint = c.req.query("contentFingerprint");
      const limit = parseAttemptListLimit(c.req.query("limit"));
      if (limit === undefined) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      const attempts = requireLedger()
        .factsByType("work_item.attempt_allocated")
        .filter(
          (fact) =>
            contentFingerprint === undefined ||
            (fact.data.contentFingerprint as { digest?: string } | undefined)?.digest ===
              contentFingerprint,
        )
        .slice(-limit)
        .map(toAttemptSummary);
      return c.json({ attempts });
    }),
  );

  // Newest recorded fact of one owner stream (`wait:<id>`, `work:<hash>`, ...).
  app.get("/admin/ledger/streams/:streamId/head", (c) =>
    respondWithLedgerRead(c, () => {
      const fact = requireLedger().headFact(c.req.param("streamId"));
      if (!fact) return c.json({ error: "Stream is empty or unknown" }, 404);
      return c.json({ fact });
    }),
  );

  // Chain tail verification report — same walk boot runs (observe-only).
  app.get("/admin/ledger/verification", (c) =>
    respondWithLedgerRead(c, () => {
      const breaks = requireLedger().verifyTail();
      return c.json({ intact: breaks.length === 0, verifiedAt: Date.now(), breaks });
    }),
  );

  // D2a archive-manifest artifact view (generated by
  // script/generate-ledger-archive-manifest.ts, never by this surface).
  app.get("/admin/ledger/archive-manifest", (c) =>
    respondWithLedgerRead(c, () => {
      const path = options.ledgerArchiveManifestPath;
      if (!path || !existsSync(path)) {
        return c.json({ error: "Archive manifest not generated" }, 404);
      }
      return c.json(JSON.parse(readFileSync(path, "utf-8")));
    }),
  );
}

const AttemptListDefaultLimit = 200;
const AttemptListMaxLimit = 1000;

/** Absent -> default; positive integer -> capped; anything else -> undefined (400). */
function parseAttemptListLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return AttemptListDefaultLimit;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, AttemptListMaxLimit);
}

function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.getAdapter().ledger;
  if (!ledger) {
    throw new Error("storage adapter does not implement ledger reads");
  }
  return ledger;
}

function respondWithLedgerRead(c: Context<Env>, read: () => Response): Response {
  try {
    return read();
  } catch (error) {
    Bus.publish(Operational.Error, {
      traceId: c.get("requestId"),
      time: Date.now(),
      component: "server",
      msg: "admin ledger query failed",
      error: error instanceof Error ? error.message : String(error),
      context: { path: c.req.path },
    });
    return c.json({ error: "Ledger query unavailable" }, 503);
  }
}

/** The attempt fact payload is the full Attempt identity plus the projected revision (see `attemptAllocatedFact`). */
function toAttemptSummary(fact: LedgerAppend.RecordedFact) {
  const { revision: _revision, ...identity } = fact.data;
  const attempt = WorkItem.Attempt.parse(identity);
  return {
    stream: fact.streamId,
    seq: fact.seq,
    attemptId: attempt.attemptId,
    attemptSeq: attempt.attemptSeq,
    retryOf: attempt.retryOf,
    reusedFromAttemptId: attempt.reusedFromAttemptId,
    contentFingerprint: attempt.contentFingerprint.digest,
    environmentFingerprint: attempt.environmentFingerprint.digest,
    timeCreated: fact.timeCreated,
  };
}

function toEventSummary(event: BusQuery.EventRecord): EventSummary {
  return {
    eventType: event.eventType,
    traceId: event.traceId,
    timeCreated: event.timeCreated,
  };
}
