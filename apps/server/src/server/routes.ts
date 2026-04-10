import { Hono } from "hono";

export function createRouter(githubWebhookHandler?: (req: Request) => Promise<Response>): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      timestamp: new Date().toISOString(),
    }),
  );

  if (githubWebhookHandler) {
    app.post("/github/webhook", async (c) => githubWebhookHandler(c.req.raw));
  }

  return app;
}
