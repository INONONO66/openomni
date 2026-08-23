import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { Projection } from "@openomni/openomni";
import { Bus } from "@openomni/telemetry";
import { createRouter } from "../../src/server/routes";

const ADMIN_TOKEN = "admin-test-token";
const path = "/admin/projections/work-items/wi-1/export";

function request(authorized = true): Request {
  return new Request(`http://localhost${path}`, {
    headers: authorized ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {},
  });
}

describe("admin projection routes", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
  });

  test("denies requests without the shared admin bearer token", async () => {
    const app = createRouter(undefined, {
      adminToken: ADMIN_TOKEN,
      projections: {
        export: () => ({ workItemId: "wi-1", rows: [], jsonl: "", sidecarDigests: [] }),
      },
    });

    const response = await app.fetch(request(false));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("maps a typed missing WorkItem to 404", async () => {
    const app = createRouter(undefined, {
      adminToken: ADMIN_TOKEN,
      projections: {
        export: (workItemId) => {
          throw new Projection.ProjectionExportError("work_item_not_found", workItemId);
        },
      },
    });

    const response = await app.fetch(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "WorkItem not found" });
  });

  test("returns the export shape", async () => {
    const app = createRouter(undefined, {
      adminToken: ADMIN_TOKEN,
      projections: {
        export: (workItemId) => ({
          workItemId,
          rows: [],
          jsonl: '{"owner_key":"work:wi-1"}\n',
          sidecarDigests: ["sha256:observation"],
        }),
      },
    });

    const response = await app.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workItemId: "wi-1",
      rowCount: 0,
      sidecarDigests: ["sha256:observation"],
      jsonl: '{"owner_key":"work:wi-1"}\n',
    });
  });
});
