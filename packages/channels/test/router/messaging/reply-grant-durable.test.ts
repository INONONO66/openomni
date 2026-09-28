import { ledger, resetLedger } from "../../helpers/ledger";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplyGrantInstances } from "../../../src/router/messaging/reply-grant";
import { resolveScopedSenderTargetGrant } from "../../../src/router/messaging/grant";

test("committed scoped reply authority survives closing storage and constructing a new router source", () => {
  {
    const directory = mkdtempSync(join(tmpdir(), "reply-grant-restart-"));
    const path = join(directory, "ledger.sqlite");
    const at = 4_000_000_000_000;
    const ports = {
      get stores() {
        return ledger().stores;
      },
      rules: () => [
        {
          id: "rule-1",
          senderId: "persona",
          surface: "telegram",
          operations: ["fire_and_forget" as const],
          instanceTtlMs: 60_000,
          maxLiveInstances: 1,
          createdBy: "owner",
        },
      ],
      publish: () => undefined,
    };
    try {
      resetLedger({ catalog: join(directory, "catalog.sqlite"), sessions: path });
      createReplyGrantInstances(ports).admit({
        actorId: "guest",
        endpoint: { channel: "telegram", externalId: "chat-1" },
        surface: "telegram",
        traceId: "trace-1",
        at,
        sourceId: "inbox-1",
      });
      resetLedger({ catalog: join(directory, "catalog.sqlite"), sessions: path });

      const grants = createReplyGrantInstances(ports).list(at);

      expect(
        resolveScopedSenderTargetGrant(grants, {
          senderId: "persona",
          targetActorId: "guest",
          operation: "fire_and_forget",
          surfaceKey: "telegram:chat-1",
          at,
        })?.id,
      ).toBe("reply-grant:rule-1:inbox-1");
      expect(
        resolveScopedSenderTargetGrant(grants, {
          senderId: "persona",
          targetActorId: "guest",
          operation: "fire_and_forget",
          surfaceKey: "telegram:chat-2",
          at,
        }),
      ).toBeUndefined();
    } finally {
  resetLedger();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
