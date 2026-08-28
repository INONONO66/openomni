import { describe, expect, it } from "bun:test";
import { placementGatedExecutor } from "@openomni/agent";
import { Placement } from "@openomni/placement";
import type { Artifact } from "@openomni/protocol";
import type { ArtifactsPort } from "../src/tools/artifacts";
import {
  READ_ARTIFACT_TOOL_NAME,
  readArtifactToolExecutor,
  WRITE_ARTIFACT_TOOL_NAME,
  writeArtifactToolExecutor,
} from "../src/tools/artifacts";
import { catalogEntries, collectToolSpecs } from "../src/tools/catalog";
import { createDispatcher, HOST_TARGET } from "../src/tools/dispatch";
import { LLM_TOOL_NAME, llmToolExecutor, MAX_LLM_CALLS } from "../src/tools/llm";

const RESIDENT = { role: "resident", depth: 0, sessionId: "session-origin" } as const;

/** An in-memory ArtifactsPort: records what store was told, serves get from it. */
function memoryArtifacts() {
  const rows = new Map<string, { sessionId: string; meta: Artifact.Meta; content: string }>();
  const port: ArtifactsPort = {
    store: (sessionId, meta, content) => {
      rows.set(meta.id, { sessionId, meta, content });
    },
    get: (artifactId) => {
      const row = rows.get(artifactId);
      return row === undefined ? null : { meta: row.meta, content: row.content };
    },
  };
  return { rows, port };
}

describe("the llm tool", () => {
  it("returns the port's answer", async () => {
    const run = llmToolExecutor(async (prompt) => `answered: ${prompt}`);
    expect(await run({ prompt: "summarize this" })).toBe("answered: summarize this");
  });

  it("refuses a malformed call without touching the port", async () => {
    let invoked = 0;
    const run = llmToolExecutor(async () => {
      invoked += 1;
      return "x";
    });
    expect(await run({ prompt: "" })).toStartWith("llm refused:");
    expect(await run({ prompt: "ok", extra: true })).toStartWith("llm refused:");
    expect(invoked).toBe(0);
  });

  it(`serves ${MAX_LLM_CALLS} calls, then refuses without invoking the port`, async () => {
    let invoked = 0;
    const run = llmToolExecutor(async () => {
      invoked += 1;
      return `call ${invoked}`;
    });

    for (let i = 1; i <= MAX_LLM_CALLS; i++) {
      expect(await run({ prompt: `q${i}` })).toBe(`call ${i}`);
    }
    const refusal = await run({ prompt: "one too many" });

    expect(refusal).toBe(
      `llm refused: the per-cell budget of ${MAX_LLM_CALLS} sub-model calls is spent`,
    );
    expect(invoked).toBe(MAX_LLM_CALLS);
  });

  it("is host-placed: it survives the cell-door fold against the brain alone", async () => {
    const entries = catalogEntries({ llm: async () => "ok" }, RESIDENT);
    const dispatcher = createDispatcher(entries);
    // The exact fold run-code.ts's cellDoor performs: resolve against the
    // host target only, then gate execution on the offerable set.
    const door = placementGatedExecutor(
      Placement.resolveTools(dispatcher.specs, [HOST_TARGET]),
      dispatcher.execute,
    );

    const result = await door({ id: "1", tool: LLM_TOOL_NAME, input: { prompt: "hi" } });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("ok");
  });
});

describe("the artifact tools", () => {
  it("round-trips content by the returned id, scoped to the origin session", async () => {
    const { rows, port } = memoryArtifacts();
    const write = writeArtifactToolExecutor(port, RESIDENT.sessionId);
    const read = readArtifactToolExecutor(port);

    const written = await write({ name: "report", content: "the whole dataset" });
    const id = written.replace("artifact stored: ", "");

    expect(written).toStartWith("artifact stored: ");
    expect(written).not.toContain("the whole dataset");
    expect(rows.get(id)?.sessionId).toBe(RESIDENT.sessionId);
    expect(rows.get(id)?.meta).toMatchObject({
      id,
      sessionId: RESIDENT.sessionId,
      title: "report",
      version: 1,
    });
    expect(await read({ artifactId: id })).toBe("the whole dataset");
  });

  it("refuses an unknown id with a typed not-found refusal", async () => {
    const { port } = memoryArtifacts();
    const read = readArtifactToolExecutor(port);

    expect(await read({ artifactId: "nope" })).toBe(
      "read_artifact refused: no artifact with id nope",
    );
  });

  it("refuses malformed calls", async () => {
    const { port } = memoryArtifacts();
    const write = writeArtifactToolExecutor(port, RESIDENT.sessionId);
    const read = readArtifactToolExecutor(port);

    expect(await write({ name: "", content: "x" })).toStartWith("write_artifact refused:");
    expect(await write({ name: "x" })).toStartWith("write_artifact refused:");
    expect(await read({ artifactId: "" })).toStartWith("read_artifact refused:");
  });
});

describe("catalog gating for the rlm tools", () => {
  it("lists all three specs in the shippable surface the lint reads", () => {
    const names = collectToolSpecs().map((spec) => spec.name);
    expect(names).toContain(LLM_TOOL_NAME);
    expect(names).toContain(WRITE_ARTIFACT_TOOL_NAME);
    expect(names).toContain(READ_ARTIFACT_TOOL_NAME);
  });

  it("is absent from the catalog when the ports are not wired", () => {
    const names = catalogEntries({}, RESIDENT).map((entry) => entry.spec.name);
    expect(names).not.toContain(LLM_TOOL_NAME);
    expect(names).not.toContain(WRITE_ARTIFACT_TOOL_NAME);
    expect(names).not.toContain(READ_ARTIFACT_TOOL_NAME);
  });

  it("appears when the ports are wired", () => {
    const { port } = memoryArtifacts();
    const names = catalogEntries({ llm: async () => "", artifacts: port }, RESIDENT).map(
      (entry) => entry.spec.name,
    );
    expect(names).toContain(LLM_TOOL_NAME);
    expect(names).toContain(WRITE_ARTIFACT_TOOL_NAME);
    expect(names).toContain(READ_ARTIFACT_TOOL_NAME);
  });

  it("offers all three on the host target", () => {
    const { port } = memoryArtifacts();
    const specs = catalogEntries({ llm: async () => "", artifacts: port }, RESIDENT).map(
      (entry) => entry.spec,
    );
    const offerable = Placement.resolveTools(specs, [HOST_TARGET])
      .filter((decision) => decision.offerable)
      .map((decision) => decision.tool.name);
    expect(offerable).toContain(LLM_TOOL_NAME);
    expect(offerable).toContain(WRITE_ARTIFACT_TOOL_NAME);
    expect(offerable).toContain(READ_ARTIFACT_TOOL_NAME);
  });
});
