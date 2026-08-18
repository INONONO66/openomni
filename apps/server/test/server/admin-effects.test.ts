import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EffectStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { assembleEffectRuntime } from "../../src/bootstrap/effects";
import { createRouter } from "../../src/server/routes";

const ADMIN_TOKEN = "admin-test-token";

function buildApp() {
  const runtime = assembleEffectRuntime();
  return createRouter(undefined, {
    adminToken: ADMIN_TOKEN,
    effects: { service: runtime.service, reconciler: runtime.reconciler },
  });
}

function authedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers ?? {}) },
  });
}

function intentRequest(body: unknown): Request {
  return authedRequest("/admin/effects/intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin effect routes", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
  });

  test("fails closed: 401 on every route while no admin token is configured", async () => {
    const runtime = assembleEffectRuntime();
    for (const adminToken of [undefined, ""]) {
      const app = createRouter(undefined, {
        ...(adminToken === undefined ? {} : { adminToken }),
        effects: { service: runtime.service, reconciler: runtime.reconciler },
      });
      const requests = [
        new Request("http://localhost/admin/effects/intents", {
          method: "POST",
          headers: { Authorization: "Bearer " },
          body: JSON.stringify({ scenario: "manual" }),
        }),
        new Request("http://localhost/admin/effects/reconcile", { method: "POST" }),
        new Request("http://localhost/admin/effects/intents/some-id"),
      ];
      for (const request of requests) {
        const response = await app.fetch(request);
        expect(response.status).toBe(401);
      }
    }
  });

  test("manual scenario runs the full record-before-act sequence to confirmed", async () => {
    const app = buildApp();
    const response = await app.fetch(intentRequest({ scenario: "manual" }));
    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      intentEventId: string;
      status: string;
      materializationCount: number;
    };
    expect(created.status).toBe("confirmed");
    expect(created.materializationCount).toBe(1);

    const read = await app.fetch(authedRequest(`/admin/effects/intents/${created.intentEventId}`));
    expect(read.status).toBe(200);
    const view = (await read.json()) as { status: string; materializationCount: number };
    expect(view.status).toBe("confirmed");
    expect(view.materializationCount).toBe(1);
  });

  test("definite-failure and unknown-result are observably distinct", async () => {
    const app = buildApp();
    const failed = (await (
      await app.fetch(intentRequest({ scenario: "definite-failure" }))
    ).json()) as {
      intentEventId: string;
      status: string;
      materializationCount: number;
    };
    expect(failed.status).toBe("failed");
    expect(failed.materializationCount).toBe(1);

    const unknown = (await (
      await app.fetch(intentRequest({ scenario: "unknown-result" }))
    ).json()) as {
      intentEventId: string;
      status: string;
      materializationCount: number;
    };
    expect(unknown.status).toBe("unknown");
    expect(unknown.materializationCount).toBe(0);
    // The unknown intent stays outcome-less on the ledger (pending), never terminalized.
    expect(EffectStore.status(unknown.intentEventId).status).toBe("pending");
  });

  test("crash-after-intent resolves to confirmed through the reconcile sweep", async () => {
    const app = buildApp();
    const created = (await (
      await app.fetch(intentRequest({ scenario: "crash-after-intent" }))
    ).json()) as { intentEventId: string; status: string };
    expect(created.status).toBe("unknown");

    const reconcile = await app.fetch(
      authedRequest("/admin/effects/reconcile", { method: "POST" }),
    );
    expect(reconcile.status).toBe(200);
    const summary = (await reconcile.json()) as { scanned: number; resolved: number };
    expect(summary.resolved).toBeGreaterThanOrEqual(1);

    const read = (await (
      await app.fetch(authedRequest(`/admin/effects/intents/${created.intentEventId}`))
    ).json()) as { intentEventId: string; status: string; materializationCount: number };
    expect(read.intentEventId).toBe(created.intentEventId);
    expect(read.status).toBe("confirmed");
    expect(read.materializationCount).toBe(1);
  });

  test("exhausting-probe drives the Stakes escalation seam through the admin surface", async () => {
    const app = buildApp();
    const created = (await (
      await app.fetch(intentRequest({ scenario: "exhausting-probe" }))
    ).json()) as { intentEventId: string; status: string };
    expect(created.status).toBe("unknown");

    const reconcile = await app.fetch(
      authedRequest("/admin/effects/reconcile", { method: "POST" }),
    );
    const summary = (await reconcile.json()) as { escalated: number; resolved: number };
    expect(summary.escalated).toBeGreaterThanOrEqual(1);
    // Never terminalized — the intent stays outcome-less and reconcilable.
    expect(EffectStore.status(created.intentEventId).status).toBe("pending");
  });

  test("unmanifested scenario is a typed 422 refusal with zero materialization", async () => {
    const app = buildApp();
    const response = await app.fetch(intentRequest({ scenario: "unmanifested-request" }));
    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { code: string; materializationCount: number };
    expect(refusal.code).toBe("unmanifested_request");
    expect(refusal.materializationCount).toBe(0);
  });

  test("unsanitized manual input is a typed 422 refusal with zero materialization", async () => {
    const app = buildApp();
    const response = await app.fetch(
      intentRequest({ scenario: "manual", input: "../../etc/passwd" }),
    );
    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { code: string; materializationCount: number };
    expect(refusal.code).toBe("unsanitized_input");
    expect(refusal.materializationCount).toBe(0);
  });

  test("rejects malformed bodies with 400 and unknown intent ids with 404", async () => {
    const app = buildApp();
    const missingScenario = await app.fetch(intentRequest({}));
    expect(missingScenario.status).toBe(400);
    const notJson = await app.fetch(
      authedRequest("/admin/effects/intents", { method: "POST", body: "not json" }),
    );
    expect(notJson.status).toBe(400);
    const absent = await app.fetch(authedRequest("/admin/effects/intents/never-intended"));
    expect(absent.status).toBe(404);
  });

  test("storage-level failures surface as 503, never as a crash or a leak", async () => {
    const { EffectStoreError } = await import("@openomni/ledger");
    const throwing = {
      service: {
        run: () => {
          throw new EffectStoreError("adapter_absent", "no ledger sub-adapter");
        },
      },
      reconciler: {
        reconcile: () => {
          throw new EffectStoreError("unavailable", "storage busy");
        },
      },
    };
    const app = createRouter(undefined, {
      adminToken: ADMIN_TOKEN,
      effects: throwing as unknown as NonNullable<Parameters<typeof createRouter>[1]>["effects"],
    });

    const created = await app.fetch(intentRequest({ scenario: "manual" }));
    expect(created.status).toBe(503);
    expect(((await created.json()) as { error: string }).error).toBe("Effect surface unavailable");

    const reconciled = await app.fetch(
      authedRequest("/admin/effects/reconcile", { method: "POST" }),
    );
    expect(reconciled.status).toBe(503);
  });

  test("routes are absent when no effect runtime is provided (reduced router)", async () => {
    const app = createRouter(undefined, { adminToken: ADMIN_TOKEN });
    const response = await app.fetch(intentRequest({ scenario: "manual" }));
    expect(response.status).toBe(404);
  });
});
