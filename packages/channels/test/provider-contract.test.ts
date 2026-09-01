import { describe, expect, test } from "bun:test";
import type { ProviderRuntime } from "../src/provider/contract";
import { ChannelProviders } from "../src/provider/registry";
import type { PublishPort } from "../src/types";

/**
 * Provider conformance: every registry entry honors the contract's structural
 * laws. Each case carries a construction closure with that provider's typed
 * credential, so a new provider is covered by adding one case — and the
 * cases-cover-registry test refuses a registration without one. Construction
 * is contractually pure (no I/O until start), which is what lets this run
 * offline.
 */

const noopPublish: PublishPort = () => {
  // Conformance constructs runtimes; nothing should publish before start().
};

interface ConformanceCase {
  readonly provider: (typeof ChannelProviders)[keyof typeof ChannelProviders];
  /** The credential the case constructs with — also the schema's positive fixture. */
  readonly credential: Record<string, string>;
  /** Per-case construction closure — keeps each provider's credential type concrete. */
  readonly build: (publish: PublishPort) => ProviderRuntime;
}

const cases: readonly ConformanceCase[] = [
  {
    provider: ChannelProviders.telegram,
    credential: { token: "tg-token" },
    build: (publish) =>
      ChannelProviders.telegram.create({ token: "tg-token" }, { triggers: [] }, publish),
  },
  {
    provider: ChannelProviders.discord,
    credential: { token: "dc-token" },
    build: (publish) =>
      ChannelProviders.discord.create({ token: "dc-token" }, { triggers: [] }, publish),
  },
  {
    provider: ChannelProviders.github,
    credential: { secret: "hook-secret", token: "api", botUsername: "omni-bot" },
    build: (publish) =>
      ChannelProviders.github.create(
        { secret: "hook-secret", token: "api", botUsername: "omni-bot" },
        { triggers: [] },
        publish,
      ),
  },
  {
    provider: ChannelProviders.slack,
    credential: { botToken: "xoxb-test", appToken: "xapp-test" },
    build: (publish) =>
      ChannelProviders.slack.create(
        { botToken: "xoxb-test", appToken: "xapp-test" },
        { triggers: [] },
        publish,
      ),
  },
];

describe("provider conformance", () => {
  test("registry keys equal provider ids", () => {
    for (const [key, provider] of Object.entries(ChannelProviders)) {
      expect(provider.id).toBe(key as keyof typeof ChannelProviders);
    }
  });

  test("every registry entry has a conformance case", () => {
    const covered: string[] = cases.map((kase) => kase.provider.id);
    expect(covered.sort()).toEqual(Object.keys(ChannelProviders).sort());
  });

  for (const kase of cases) {
    describe(kase.provider.id, () => {
      test("runtime seams match declared capabilities", () => {
        const runtime = kase.build(noopPublish);
        expect(runtime.surface.id).toBe(kase.provider.id);
        expect(runtime.deliveryRoute !== undefined).toBe(kase.provider.capabilities.deliver);
        expect(runtime.webhookHandler !== undefined).toBe(kase.provider.capabilities.webhook);
      });

      test("credentials schema admits the conformance credential and refuses junk", () => {
        expect(kase.provider.credentials.safeParse(kase.credential).success).toBe(true);
        expect(kase.provider.credentials.safeParse({ bogus: "x" }).success).toBe(false);
        // strict: an extra key on a valid payload is refused, never silently dropped
        expect(kase.provider.credentials.safeParse({ ...kase.credential, extra: "x" }).success).toBe(
          false,
        );
      });

      test("settings schema — no shipped knobs: empty accepted, any key refused", () => {
        expect(kase.provider.settings.safeParse({}).success).toBe(true);
        expect(kase.provider.settings.safeParse({ knob: "x" }).success).toBe(false);
      });

      test("render policy is a usable dialect mapping with a sane limit", () => {
        const rendered = kase.provider.capabilities.render.renderMarkdown("**hi** `code`");
        expect(typeof rendered).toBe("string");
        expect(rendered.length).toBeGreaterThan(0);
        const limit = kase.provider.capabilities.render.messageLimit;
        if (limit !== null) {
          expect(Number.isInteger(limit)).toBe(true);
          expect(limit).toBeGreaterThan(0);
        }
      });

      test("preconditions are a verbatim operator checklist", () => {
        for (const precondition of kase.provider.preconditions) {
          expect(precondition.length).toBeGreaterThan(0);
        }
      });

      test("construction is pure — nothing published before start", () => {
        let published = 0;
        const recordingPublish: PublishPort = (...args: Parameters<PublishPort>) => {
          published += 1;
          return noopPublish(...args);
        };
        kase.build(recordingPublish);
        expect(published).toBe(0);
      });
    });
  }
});
