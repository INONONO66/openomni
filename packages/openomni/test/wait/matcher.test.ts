import { afterEach, describe, expect, test } from "bun:test";
import type { Wait } from "@openomni/protocol";
import { ActorRegistry, Storage } from "@openomni/ledger";
import { targetsOfWait } from "../../src/wait/index";
import { buildWaitRecord, correlationFixture } from "../helpers/wait";

// The matcher core (rules, evidence extensions, target folds) is protocol-pure
// and tested there (protocol/test/wait/matcher.test.ts). This suite covers the
// kernel's effectful half of the #707 split alone: the ActorRegistry read that
// resolves a wait's delivery endpoint to its registered actor before the pure
// core matches.
describe("wait matcher — registry-anchored delivery resolution", () => {
  afterEach(() => {
    Storage.reset();
  });

  test("pins the delivery endpoint on the registry-resolved delivery actor only", () => {
    Storage.initialize({ dbPath: ":memory:" });
    ActorRegistry.registerIdentity({
      id: "actor-target",
      kind: "ai_agent",
      trustTier: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-target",
      actorId: "actor-target",
      channel: "telegram",
      externalId: "target-1",
    });
    const record = buildWaitRecord("wait-delivery-pin", {
      correlation: { endpointId: "endpoint-target", channelId: correlationFixture.channelId },
      expectedResponders: ["actor-target", "actor-r2"],
    });

    expect(targetsOfWait(record)).toEqual([
      { responderId: "actor-target", targetActorId: "actor-target", endpointId: "endpoint-target" },
      { responderId: "actor-r2", targetActorId: "actor-r2" },
    ] satisfies Wait.ResponderTarget[]);
  });

  test("fails closed when the delivery endpoint no longer resolves in the registry", () => {
    Storage.initialize({ dbPath: ":memory:" });
    const record = buildWaitRecord("wait-unresolvable", {
      correlation: { endpointId: "endpoint-gone", channelId: correlationFixture.channelId },
      expectedResponders: ["actor-target"],
    });

    expect(targetsOfWait(record)).toEqual([]);
  });

  test("needs no registry read for a wait without a delivery endpoint pin", () => {
    // No Storage.initialize: an unpinned wait must not touch the registry.
    const record = buildWaitRecord("wait-unpinned", {
      correlation: { channelId: correlationFixture.channelId, threadId: "thread-1" },
      expectedResponders: ["actor-a", "actor-b"],
    });

    expect(targetsOfWait(record)).toEqual([
      { responderId: "actor-a", targetActorId: "actor-a" },
      { responderId: "actor-b", targetActorId: "actor-b" },
    ] satisfies Wait.ResponderTarget[]);
  });
});
