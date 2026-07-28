import { Hono } from "hono";
import { cors } from "hono/cors";
import { Operational } from "@openomni/protocol";
import { Bus, BusQuery } from "@openomni/session";

type Env = { Variables: { requestId: string } };

type EventSummary = {
  eventType: string;
  traceId: string;
  timeCreated: number;
};

type RouterOptions = {
  observabilityToken?: string;
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

  if (options.observabilityToken) {
    app.get("/observability/sessions/:sessionId/events", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${options.observabilityToken}`) {
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
  }

  if (githubWebhookHandler) {
    app.post("/github/webhook", async (c) => githubWebhookHandler(c.req.raw));
  }

  return app;
}

function toEventSummary(event: BusQuery.EventRecord): EventSummary {
  return {
    eventType: event.eventType,
    traceId: event.traceId,
    timeCreated: event.timeCreated,
  };
}
