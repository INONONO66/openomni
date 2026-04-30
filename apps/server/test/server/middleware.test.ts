import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/server/routes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("request-id middleware", () => {
  test("response includes X-Request-Id header with UUID format", async () => {
    const app = createRouter();
    const res = await app.fetch(new Request("http://localhost/health"));
    const id = res.headers.get("X-Request-Id");

    expect(id).toBeTruthy();
    expect(id).toMatch(UUID_RE);
  });

  test("each request gets a unique request id", async () => {
    const app = createRouter();
    const res1 = await app.fetch(new Request("http://localhost/health"));
    const res2 = await app.fetch(new Request("http://localhost/health"));

    const id1 = res1.headers.get("X-Request-Id");
    const id2 = res2.headers.get("X-Request-Id");

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
});

describe("CORS middleware", () => {
  test("response includes Access-Control-Allow-Origin: *", async () => {
    const app = createRouter();
    const res = await app.fetch(new Request("http://localhost/health"));

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("preflight OPTIONS request returns CORS headers", async () => {
    const app = createRouter();
    const res = await app.fetch(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeTruthy();
  });
});
