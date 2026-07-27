import { Hono } from "hono";
import { cors } from "hono/cors";
import { Operational } from "@openomni/protocol";

type Env = { Variables: { requestId: string } };

type EventSummary = {
  readonly eventType: string;
  readonly traceId: string;
  readonly timeCreated: number;
};

type WorkerRunSummary = {
  readonly runId: string;
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
};

export type RedactedSessionObservabilityProjection = {
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly errors: readonly EventSummary[];
  readonly workerRuns: readonly WorkerRunSummary[];
  readonly chainIntegrity: {
    readonly verification: "canonical_event_hash_and_owner_linkage_v1";
    readonly valid: boolean;
    readonly eventCount: number;
  };
};

export interface OwnerObservabilityProjectionQuery {
  session(sessionId: string): Promise<RedactedSessionObservabilityProjection>;
}

export interface RouterObservabilityPort {
  publish(
    event: typeof Operational.Info | typeof Operational.Error,
    payload: Record<string, unknown>,
  ): void;
}

export interface RouterDependencies {
  readonly githubWebhookHandler?: (req: Request) => Promise<Response>;
  readonly observability: RouterObservabilityPort;
  readonly ownerProjection?: {
    readonly token: string;
    readonly queries: OwnerObservabilityProjectionQuery;
  };
}

export function createRouter(dependencies: RouterDependencies): Hono<Env> {
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
    dependencies.observability.publish(Operational.Info, {
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

  if (dependencies.ownerProjection) {
    const { queries: observabilityQueries, token: observabilityToken } =
      dependencies.ownerProjection;
    app.get("/observability/sessions/:sessionId/events", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${observabilityToken}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const sessionId = c.req.param("sessionId");
      try {
        const projection = await observabilityQueries.session(sessionId);
        return c.json({ sessionId, ...projection });
      } catch (error) {
        dependencies.observability.publish(Operational.Error, {
          traceId: c.get("requestId"),
          time: Date.now(),
          component: "server",
          msg: "observability projection query failed",
          error: error instanceof Error ? error.message : String(error),
          context: { sessionId },
        });
        return c.json({ error: "Observability query unavailable" }, 503);
      }
    });
  }

  const githubWebhookHandler = dependencies.githubWebhookHandler;
  if (githubWebhookHandler) {
    app.post("/github/webhook", async (c) => githubWebhookHandler(c.req.raw));
  }

  return app;
}
