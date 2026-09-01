import { beforeEach, describe, expect, it } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import type { GatewayRouter } from "../../src/router/index.js";
import { kernelRouter, resetRouterState } from "./_router-fixture";

let router: GatewayRouter;

beforeEach(() => {
  resetRouterState();
  for (const surface of ["slack", "tui"]) {
    ChannelGrantStore.put({
      id: `grant-${surface}`,
      surface,
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
  }
  router = kernelRouter();
});

describe("GatewayRouter integration pipeline", () => {
  describe("direct mode conversation history", () => {
    it("routes a second turn on the same surface key to the same session", async () => {
      const first = await router.ingest({
        id: "evt-direct-1",
        traceId: "trace-test",
        mode: "direct",
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
        payload: "Hello",
        meta: { actor: { role: "user" } },
      });

      const second = await router.ingest({
        id: "evt-direct-2",
        traceId: "trace-test",
        mode: "direct",
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
        payload: "Follow up",
        meta: { actor: { role: "user" } },
      });

      expect(first.mode).toBe("direct");
      expect(second.mode).toBe("direct");
      if (first.kind === "dropped" || second.kind === "dropped") throw new Error("shape");
      expect(first.sessionId).toBe(second.sessionId);
    });
  });

  describe("session isolation", () => {
    it("does not leak context across different surface keys", async () => {
      const first = await router.ingest({
        id: "evt-isolation-a",
        traceId: "trace-test",
        mode: "direct",
        surface: "tui",
        workspace: "/project-a",
        payload: "Message A",
        meta: { actor: { role: "user" } },
      });

      const second = await router.ingest({
        id: "evt-isolation-b",
        traceId: "trace-test",
        mode: "direct",
        surface: "tui",
        workspace: "/project-b",
        payload: "Message B",
        meta: { actor: { role: "user" } },
      });

      if (first.kind === "dropped" || second.kind === "dropped") throw new Error("shape");
      expect(first.sessionId).not.toBe(second.sessionId);
    });
  });

  describe("sender allowlist", () => {
    it("blocks a stranger and routes an allowlisted sender on the same surface", async () => {
      ChannelGrantStore.put({
        id: "grant-telegram",
        surface: "telegram",
        kind: "trusted_channel",
        defaultTier: "owner",
        allowedSenders: ["111"],
        createdBy: "act_owner",
      });

      await expect(
        router.ingest({
          id: "evt-tg-stranger",
          traceId: "trace-test",
          mode: "direct",
          surface: "telegram",
          userId: "999",
          payload: "hello",
          meta: { actor: { role: "user" } },
        }),
      ).rejects.toMatchObject({ code: "route_blocked" });

      const owner = await router.ingest({
        id: "evt-tg-owner",
        traceId: "trace-test",
        mode: "direct",
        surface: "telegram",
        userId: "111",
        payload: "hello",
        meta: { actor: { role: "user" } },
      });
      if (owner.kind === "dropped") throw new Error("shape");
      expect(owner.sessionId).toBeDefined();
    });
  });

  describe("error cases", () => {
    it("throws zod error when mode is missing", async () => {
      const invalidEvent = {
        id: "evt-invalid-no-mode",
        surface: "tui",
        payload: "hello",
      };

      let caught: unknown;
      try {
        await router.ingest(invalidEvent);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        caught = error;
      }
      // The router parses Gateway.DeliveredEvent strictly — the abort surface
      // is the original ZodError (asserted by name: zod is protocol's
      // dependency, not a channels import).
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("ZodError");
    });
  });
});
