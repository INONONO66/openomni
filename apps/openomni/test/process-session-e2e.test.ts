import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import { ProcessWorkerResult } from "../src/delegation/process-entry";
import { z } from "zod";

const Request = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    }),
  ),
});
function response(tool: boolean): Response {
  const block = tool
    ? { type: "tool_use", id: "recursive-call", name: "delegate", input: {} }
    : { type: "text", text: "" };
  const delta = tool
    ? {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          operation: "ask",
          scope: "inline",
          instruction: "child leaf",
          timeoutMs: 10000,
        }),
      }
    : { type: "text_delta", text: "process completed" };
  const frames = [
    {
      type: "message_start",
      message: {
        id: crypto.randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-opus-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("spawned production entry uses the session loop and permits a recursive inline child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-937-process-"));
  const dbPath = join(directory, "chat.sqlite");
  let requests = 0;
  const authorization: (string | null)[] = [];
  const bodies: z.infer<typeof Request>[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests += 1;
      authorization.push(request.headers.get("x-api-key"));
      bodies.push(Request.parse(await request.json()));
      return response(requests === 1);
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    initialize({ dbPath });
    SessionHandleStore.materialize({
      id: "process-parent",
      role: "resident",
      parentId: null,
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "parent-config",
      at: 1,
    });
    Storage.reset();
    child = Bun.spawn([process.execPath, "apps/openomni/src/delegation/process-entry.ts"], {
      cwd: new URL("../../..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENOMNI_DISABLE_MODELS_FETCH: "1" },
    });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const stdin = child.stdin as import("bun").FileSink;
    stdin.write(
      `${JSON.stringify({ delegationId: "process-worker", workerRunId: "commissioned-run", operation: "assign", instruction: "ask an inline child then report", acceptanceCriteria: ["child replied"], origin: { role: "worker", depth: 1, sessionId: "process-parent" }, model: { provider: "anthropic", id: "claude-opus-4-5" }, apiKey: "process-key", transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` }, dbPath })}\n`,
    );
    stdin.end();
    expect(await child.exited).toBe(0);
    const output = await stdout;
    const error = await stderr;
    console.log("937 actual process", JSON.stringify({ pid: child.pid, requests, output, error }));
    const lines = output.trim().split("\n");
    expect(JSON.parse(lines[0] ?? "null")).toEqual({ delivered: true });
    const result = ProcessWorkerResult.parse(JSON.parse(lines[1] ?? "null"));
    expect(result).toMatchObject({ status: "completed", output: "process completed" });
    expect(requests).toBe(3);
    expect(authorization).toEqual(["process-key", "process-key", "process-key"]);
    expect(JSON.stringify(bodies[1])).toContain("child leaf");
    const db = new Database(dbPath, { readonly: true });
    try {
      const workers = db
        .query("SELECT id, parent_id FROM session WHERE role='worker' ORDER BY time_created, id")
        .all();
      expect(workers).toHaveLength(2);
      expect(workers).toContainEqual({ id: "process-worker", parent_id: "process-parent" });
      const childRow = workers.find(
        (row) =>
          typeof row === "object" && row !== null && "id" in row && row.id !== "process-worker",
      );
      expect(childRow).toMatchObject({ parent_id: "process-worker" });
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM action WHERE kind='turn' AND json_extract(intent,'$.phase')='stop'",
          )
          .get(),
      ).toEqual({ count: 3 });
      expect(
        db.query("SELECT count(*) AS count FROM session WHERE lease_owner IS NOT NULL").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  } finally {
    child?.kill();
    if (child !== undefined) await child.exited;
    await provider.stop(true);
    Storage.reset();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
