import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { main } from "../../src/bootstrap";
import { shutdownP2Runtime, type ShutdownDeps } from "../../src/bootstrap/shutdown";
import { createRouter } from "../../src/server/routes";

function observability() {
  return { publish: () => undefined };
}

describe("server composition root", () => {
  test("health endpoint returns an observable success response", async () => {
    const app = createRouter({ observability: observability() });
    const response = await app.fetch(new Request("http://localhost/health"));
    const body = (await response.json()) as { ok: boolean; timestamp: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  test("refuses boot without an explicitly injected semantic composition", async () => {
    await expect(main()).rejects.toThrow(
      "P2 server bootstrap requires an explicit semantic runtime composition",
    );
  });

  test("keeps recovery ahead of every HTTP and channel producer", () => {
    const source = readFileSync(new URL("../../src/bootstrap/index.ts", import.meta.url), "utf8");
    const recovery = source.indexOf("await runRecovery(services.recovery, traceId)");
    const httpProducer = source.indexOf("const server = Bun.serve(");
    const channelProducer = source.indexOf(
      "await Promise.all(channels.map((channel) => channel.start()))",
    );

    expect(recovery).toBeGreaterThan(-1);
    expect(httpProducer).toBeGreaterThan(recovery);
    expect(channelProducer).toBeGreaterThan(httpProducer);
  });

  test("closes an opened runtime when the injected semantic bundle is refused", () => {
    const source = readFileSync(new URL("../../src/bootstrap/index.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "try {\n    services = requireSemanticServices(runtime.services);\n  } catch (error) {\n    await runtime.close();\n    throw error;\n  }",
    );
  });

  test("shutdown stops producers before coordinator, providers, and runtime in order", async () => {
    const order: string[] = [];
    const deps = {
      ingress: { stop: () => order.push("ingress") },
      channels: [{ stop: () => order.push("channel-1") }, { stop: () => order.push("channel-2") }],
      server: { stop: (force: boolean) => order.push(`server:${force}`) },
      cronRunner: { stop: () => order.push("cron") },
      coordinator: { shutdown: async () => void order.push("coordinator") },
      mcpProvider: { disconnectAll: async () => void order.push("mcp") },
      runtime: { close: async () => void order.push("runtime") },
      incidents: {
        report: () => order.push("incident-report"),
        dispose: () => order.push("incidents"),
      },
      exit: (code: number) => order.push(`exit:${code}`),
    } satisfies ShutdownDeps;

    await shutdownP2Runtime(deps, "test");

    expect(order).toEqual([
      "ingress",
      "channel-1",
      "channel-2",
      "server:true",
      "cron",
      "coordinator",
      "mcp",
      "runtime",
      "incidents",
      "exit:0",
    ]);
  });
});
