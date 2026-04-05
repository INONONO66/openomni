import { afterEach, expect, test } from "bun:test";
import { createRouter } from "../../src/routes";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  if (server) {
    server.stop();
    server = null;
  }
});

test("server health endpoint returns ok", async () => {
  const app = createRouter();

  const req = new Request("http://localhost/health");
  const res = await app.fetch(req);
  const body = (await res.json()) as { ok: boolean; timestamp: string };

  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(typeof body.timestamp).toBe("string");
});

test("server boot and shutdown smoke", async () => {
  const app = createRouter();
  server = Bun.serve({ port: 0, fetch: app.fetch });

  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  const body = (await res.json()) as { ok: boolean };

  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);

  server.stop();
  server = null;
});
