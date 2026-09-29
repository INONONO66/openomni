import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com",
    doc: "dropped by the projection",
    models: {
      "claude-example": {
        id: "claude-example",
        name: "Claude Example",
        family: "claude",
        release_date: "2026-01-01",
        status: "stable",
        limit: { context: 200_000, output: 8192 },
        provider: { npm: "@ai-sdk/anthropic" },
        cost: { input: 3 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-example": { id: "gpt-example", name: "GPT Example" },
    },
  },
  ignored: { id: "ignored", name: "Not bundled", env: [], npm: "x", models: {} },
};

test("projects the bundled providers of the models.dev catalog into the snapshot", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(catalog) });
  const previousUrl = process.env.MODELS_DEV_URL;
  process.env.MODELS_DEV_URL = server.url.toString();
  const root = mkdtempSync(join(tmpdir(), "models-snapshot-"));
  roots.push(root);
  const cwd = process.cwd();
  process.chdir(root);
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logs.push(message);
  });
  try {
    const { main } = await import("./generate-models-snapshot");
    await main();
  } finally {
    log.mockRestore();
    process.chdir(cwd);
    if (previousUrl === undefined) {
      delete process.env.MODELS_DEV_URL;
    } else {
      process.env.MODELS_DEV_URL = previousUrl;
    }
    server.stop(true);
  }
  const written: unknown = JSON.parse(
    readFileSync(join(root, "packages/llm/src/model/models-snapshot.json"), "utf8"),
  );
  expect(written).toEqual({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com",
      models: {
        "claude-example": {
          id: "claude-example",
          name: "Claude Example",
          family: "claude",
          release_date: "2026-01-01",
          status: "stable",
          limit: { context: 200_000 },
          provider: { npm: "@ai-sdk/anthropic" },
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      models: { "gpt-example": { id: "gpt-example", name: "GPT Example" } },
    },
  });
  expect(logs).toEqual([
    "[generate-models-snapshot] wrote packages/llm/src/model/models-snapshot.json (2 providers)",
  ]);
});
