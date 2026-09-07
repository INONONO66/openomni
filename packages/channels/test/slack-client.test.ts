import { afterEach, describe, expect, it } from "bun:test";
import { SlackClient } from "../src/provider/slack/client";
import { SlackApiError } from "../src/provider/slack/error";
import type { PublishPort } from "../src/types";
import type { PlainValue } from "@openomni/protocol";

const noopPublish: PublishPort = () => undefined;

interface RecordedCall {
  readonly method: string;
  readonly authorization: string;
  readonly body: Record<string, unknown>;
}

/** Routes slack Web API calls to scripted bodies and records what was sent. */
function installFetchMock(respond: (method: string) => { status?: number; body: PlainValue }): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      authorization: headers.get("Authorization") ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const scripted = respond(method);
    return new Response(JSON.stringify(scripted.body), {
      status: scripted.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

describe("SlackClient", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = () => new SlackClient("xoxb-bot", "xapp-app", noopPublish);

  it("opens the Socket Mode URL with the app token — the only app-token call", async () => {
    const { calls } = installFetchMock(() => ({
      body: { ok: true, url: "wss://socket.slack.example/link/1" },
    }));
    const url = await client().openSocketUrl("trace-1");
    expect(url).toBe("wss://socket.slack.example/link/1");
    expect(calls).toEqual([
      {
        method: "apps.connections.open",
        authorization: "Bearer xapp-app",
        body: {},
      },
    ]);
  });

  it("throws a typed error when apps.connections.open returns no url", async () => {
    installFetchMock(() => ({ body: { ok: true } }));
    const error = await client()
      .openSocketUrl("trace-1")
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(SlackApiError.isInstance(error)).toBe(true);
  });

  it("surfaces slack's in-body refusal (`ok:false`) as a typed error", async () => {
    installFetchMock(() => ({ body: { ok: false, error: "invalid_auth" } }));
    await expect(client().authTest("trace-1")).rejects.toThrow(
      "slack auth.test refused: invalid_auth",
    );
  });

  it("surfaces an HTTP-level failure as a typed error", async () => {
    installFetchMock(() => ({ status: 500, body: { ok: false } }));
    await expect(client().authTest("trace-1")).rejects.toThrow("slack auth.test failed (500)");
  });

  it("authTest returns the bot user id and team, on the bot token", async () => {
    const { calls } = installFetchMock(() => ({
      body: { ok: true, user_id: "UBOT", team_id: "T9" },
    }));
    expect(await client().authTest("trace-1")).toEqual({ botUserId: "UBOT", team: "T9" });
    expect(calls[0]?.authorization).toBe("Bearer xoxb-bot");
  });

  it("throws a typed error when auth.test omits identity fields", async () => {
    installFetchMock(() => ({ body: { ok: true, user_id: "UBOT" } }));
    await expect(client().authTest("trace-1")).rejects.toThrow(
      "auth.test returned no user_id/team_id",
    );
  });

  it("send posts to the channel and returns the message ts", async () => {
    const { calls } = installFetchMock(() => ({ body: { ok: true, ts: "1710.1" } }));
    expect(await client().send("C1", "hello", "trace-1")).toBe("1710.1");
    expect(calls[0]?.body).toEqual({ channel: "C1", text: "hello" });
  });

  it("send returns undefined when slack omits the ts", async () => {
    installFetchMock(() => ({ body: { ok: true } }));
    expect(await client().send("C1", "hello", "trace-1")).toBeUndefined();
  });

  it("sendInThread anchors the post to the thread root", async () => {
    const { calls } = installFetchMock(() => ({ body: { ok: true, ts: "1710.2" } }));
    expect(await client().sendInThread("C1", "1710.0", "reply", "trace-1")).toBe("1710.2");
    expect(calls[0]?.body).toEqual({ channel: "C1", text: "reply", thread_ts: "1710.0" });
  });

  it("sendInThread returns undefined when slack omits the ts", async () => {
    installFetchMock(() => ({ body: { ok: true } }));
    expect(await client().sendInThread("C1", "1710.0", "reply", "trace-1")).toBeUndefined();
  });

  it("openDm opens a conversation and returns its channel id", async () => {
    const { calls } = installFetchMock(() => ({
      body: { ok: true, channel: { id: "D77" } },
    }));
    expect(await client().openDm("U5", "trace-1")).toBe("D77");
    expect(calls[0]?.body).toEqual({ users: "U5" });
  });

  it("throws a typed error when conversations.open returns no channel id", async () => {
    installFetchMock(() => ({ body: { ok: true, channel: {} } }));
    const error = await client()
      .openDm("U5", "trace-1")
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(SlackApiError.isInstance(error)).toBe(true);
  });
});
