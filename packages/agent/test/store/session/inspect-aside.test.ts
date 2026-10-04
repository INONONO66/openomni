import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useMemoryStores, testNow } from "../helpers/storage";
import { CHILD, PARENT, forkFixture } from "../helpers/fork-fixture";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { openSessionStore, type SessionStore } from "../../../src/core/store/session-file";
import { forkAncestryOf, forkAside, forkAsideRewrite } from "../../../src/inspect/tree";
import { foldSessionHistory } from "../../../src/inspect/history";

const stores = useMemoryStores();
let childStore: SessionStore | undefined;

beforeEach(() => {
  childStore = openSessionStore(":memory:", { now: testNow });
});

afterEach(() => {
  childStore?.close();
  childStore = undefined;
});

function child(): SessionStore {
  if (childStore === undefined) throw new Error("child store only exists inside a test");
  return childStore;
}

const fixture = forkFixture(stores, child);

describe("inspect aside (#1257)", () => {
  test("the aside is an inspect projection, never model context or compaction input", () => {
    const parent = fixture.buildParent();
    fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const ancestry = forkAncestryOf(childKernel, CHILD);
    if (ancestry === null) throw new Error("child ancestry missing");
    const aside = forkAside(ancestry);
    expect(aside).toContain(PARENT);
    expect(aside).toContain(ancestry.anchor);

    // Model context: the canonical history fold over the child chain carries
    // the copied conversation but never the aside text; compaction folds over
    // this same history, so the aside cannot leak there either.
    const actions = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    const messages = foldSessionHistory(CHILD, actions);
    const rendered = JSON.stringify(messages);
    expect(rendered).toContain("first");
    expect(rendered).toContain("done");
    expect(rendered).not.toContain("Forked from session");
    expect(rendered).not.toContain(ancestry.anchor);
  });

  test("only the opt-in prompt.pre rewrite promotes the fork summary", () => {
    const parent = fixture.buildParent();
    fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const ancestry = forkAncestryOf(childKernel, CHILD);
    if (ancestry === null) throw new Error("child ancestry missing");
    const aside = forkAside(ancestry);

    const handler = forkAsideRewrite((id) => (id === CHILD ? ancestry : null), CHILD);
    const service = () => handler;
    const promoted = handler({ value: "hello", params: null, service });
    expect(promoted.value).toBe(`${aside}\n\nhello`);
    expect(promoted.payload).toEqual({ promoted: true });

    // Non-text values and sessions without ancestry pass through untouched.
    const skipped = handler({ value: { not: "text" }, params: null, service });
    expect(skipped.value).toBeUndefined();
    expect(skipped.payload).toEqual({ promoted: false });
    const rootHandler = forkAsideRewrite(() => null, PARENT);
    expect(rootHandler({ value: "hello", params: null, service }).value).toBeUndefined();
  });
});
