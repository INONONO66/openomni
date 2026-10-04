// #1254 H4 (issue line 77 "Fencing is atomic or checked against catalog at
// commit"): the authoritative catalog fence is checked INSIDE the session
// commit transaction, so a rotation that lands after the writer was admitted
// but before its session write refuses the commit instead of landing a stale
// write.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import type { CatalogStore } from "../../../src/core/store/catalog";
import { openCatalogStore } from "../../../src/core/store/catalog";
import { createSessionKernel, type SessionKernel } from "../../../src/core/store/fence";
import { openSessionStore } from "../../../src/core/store/session-file";
import { runLedgerSync } from "../../store/helpers/effect";
import { TEST_NOW, testNow } from "../../store/helpers/storage";

const SESSION_ID = "h4";
const OWNER = "runner:h4";

function armAction(id: string): LedgerAction.Append {
  return {
    id,
    parentId: null,
    sessionId: SESSION_ID,
    kind: "alarm",
    intent: { encodingVersion: 1, value: { op: "arm", alarmId: "a", at: TEST_NOW + 60_000 } },
    effect: { encodingVersion: 1, value: { occurrenceId: `${id}:occ` } },
    irreversible: true,
    ts: TEST_NOW,
  };
}

function commitWith(kernel: SessionKernel, fence: number, action: LedgerAction.Append) {
  const row = kernel.row(SESSION_ID);
  return kernel.commit({
    sessionId: SESSION_ID,
    owner: OWNER,
    fence,
    now: TEST_NOW,
    expectedRevision: row.revision,
    actions: [action],
    state: row.state,
  });
}

function setup(catalogOf: (catalog: CatalogStore) => CatalogStore = (catalog) => catalog) {
  const directory = mkdtempSync(join(tmpdir(), "fence-catalog-commit-"));
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  const session = openSessionStore(join(directory, `${SESSION_ID}.sqlite`), { now: testNow });
  const kernel = createSessionKernel(session, catalogOf(catalog));
  runLedgerSync(
    kernel.materialize({
      id: SESSION_ID,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: `${SESSION_ID}:configure`,
      at: 1,
    }),
  );
  catalog.indexSession({ id: SESSION_ID, parentId: null, role: "resident", createdAt: 1 });
  expect(catalog.rotateFence(SESSION_ID)).toBe(1);
  runLedgerSync(kernel.adoptFence({ sessionId: SESSION_ID, owner: OWNER, fence: 1 }));
  const close = () => {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true });
  };
  return { catalog, kernel, close };
}

/** The reviewer's H4 seam: `markArmed` runs after admission and before the
 * session transaction, so a rotation injected there models a cross-process
 * takeover landing in exactly that window. */
function rotateOnMarkArmed(catalog: CatalogStore): CatalogStore {
  return new Proxy(catalog, {
    get(target, property) {
      if (property === "markArmed")
        return (sessionId: string, armed: boolean) => {
          target.rotateFence(sessionId);
          target.markArmed(sessionId, armed);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a rotation landing between admission and the session transaction refuses the stale commit", () => {
  const world = setup(rotateOnMarkArmed);
  try {
    const { catalog, kernel } = world;
    const before = kernel.row(SESSION_ID);
    const refused = runLedgerSync(Effect.flip(commitWith(kernel, 1, armAction("h4-race"))));
    expect(refused).toMatchObject({ _tag: "FenceRefused", reason: "stale", fence: 2 });
    expect(catalog.sessionIndex(SESSION_ID)?.fence).toBe(2);
    // Nothing of the stale writer survives: no action row, no revision bump,
    // and the committed fence stays at the pre-rotation value.
    expect(kernel.actionById("h4-race")).toBeUndefined();
    expect(kernel.row(SESSION_ID)).toMatchObject({
      revision: before.revision,
      fence: 1,
      fenceOwner: OWNER,
    });
  } finally {
    world.close();
  }
});

test("reviewer probe regression: catalog rotated to 2, commit with fence 1 is refused and appends nothing", () => {
  const world = setup();
  try {
    const { catalog, kernel } = world;
    expect(catalog.rotateFence(SESSION_ID)).toBe(2);
    const before = kernel.row(SESSION_ID);
    const refused = runLedgerSync(Effect.flip(commitWith(kernel, 1, armAction("h4-probe"))));
    expect(refused).toMatchObject({ _tag: "FenceRefused", reason: "stale", fence: 2 });
    expect(kernel.actionById("h4-probe")).toBeUndefined();
    expect(kernel.row(SESSION_ID)).toMatchObject({ revision: before.revision, fence: 1 });
  } finally {
    world.close();
  }
});

test("catalog and writer agree: the commit lands", () => {
  const world = setup();
  try {
    const { kernel } = world;
    const before = kernel.row(SESSION_ID);
    const receipt = runLedgerSync(commitWith(kernel, 1, armAction("h4-ok")));
    expect(receipt.ok).toBe(true);
    expect(kernel.actionById("h4-ok")).toBeDefined();
    expect(kernel.row(SESSION_ID).revision).toBe(before.revision + 1);
  } finally {
    world.close();
  }
});
