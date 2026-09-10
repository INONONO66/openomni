import { ChannelProviders } from "@openomni/channels";
import type { Channel } from "@openomni/protocol";

class FakeSurface implements Channel.Surface {
  handler: Channel.MessageHandler | null = null;
  started = false;
  stopped = false;

  constructor(
    readonly id: string,
    readonly config: Channel.Config,
    readonly credentials: unknown,
  ) {}

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  start(_traceId: string): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(_traceId: string): void {
    this.stopped = true;
  }
}

/** Keep shipped schemas and capabilities; record only the external provider IO. */
export function fakeProviders() {
  const surfaces: FakeSurface[] = [];
  const delivered: { externalId: string; body: string }[] = [];
  const webhookCalls: Request[] = [];
  const delivery = (id: string, credentials: unknown, config: Channel.Config, messageId: string) => {
    const surface = new FakeSurface(id, config, credentials);
    surfaces.push(surface);
    return {
      surface,
      deliveryRoute: (externalId: string, body: string) => {
        delivered.push({ externalId, body });
        return Promise.resolve({ value: "accepted" as const, externalMessageId: messageId });
      },
    };
  };
  const providers: typeof ChannelProviders = {
    telegram: {
      ...ChannelProviders.telegram,
      create: (credentials, config) => delivery("telegram", credentials, config, "tg-1"),
    },
    discord: {
      ...ChannelProviders.discord,
      create: (credentials, config) => delivery("discord", credentials, config, "dc-1"),
    },
    slack: {
      ...ChannelProviders.slack,
      create: (credentials, config) => delivery("slack", credentials, config, "sl-1"),
    },
    github: {
      ...ChannelProviders.github,
      create(credentials, config) {
        const surface = new FakeSurface("github", config, credentials);
        surfaces.push(surface);
        return {
          surface,
          webhookHandler: (request) => {
            webhookCalls.push(request);
            return Promise.resolve(new Response("OK", { status: 200 }));
          },
        };
      },
    },
  };
  return { surfaces, providers, delivered, webhookCalls };
}

export type FakeBuild = ReturnType<typeof fakeProviders>;
