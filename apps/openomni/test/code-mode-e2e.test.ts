import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import type { RunInput, Sink } from "@openomni/llm";
import { attachMachineDaemon, type MachineDaemon } from "@openomni/machines";
import type { Machine, Message } from "@openomni/protocol";
import { startOpenOmni } from "../src/index";

const WS_TOKEN = "code-mode-e2e-token";
const MACHINE_ID = "alpha";

const directories: string[] = [];
let stopApp: (() => void) | undefined;
let daemon: MachineDaemon | undefined;

afterEach(() => {
  daemon?.close();
  daemon = undefined;
  stopApp?.();
  stopApp = undefined;
  Storage.reset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function message(input: RunInput, text: string): Message.WithParts {
  const id = `fake-${input.trace.sessionId}-${input.messages.length}`;
  const sessionID = input.trace.sessionId;
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "resident",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}-text`, sessionID, messageID: id, type: "text", text } as never,
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}

const enrollment: Machine.Enrollment = {
  machineId: MACHINE_ID,
  name: "the laptop",
  allowedCapabilities: ["kernel.py"],
  enrolledAt: 0,
};

/**
 * The payoff, end to end and with a real daemon: one cell makes three
 * delegate calls that would otherwise be three turns, and the answers come
 * back inside the cell rather than to the model.
 */
test("a cell batches delegation into one turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-code-mode-"));
  directories.push(directory);
  const socketPath = join(directory, "machines.sock");
  const residentTurns: string[] = [];

  const app = await startOpenOmni({
    config: {
      dbPath: join(directory, "chat.db"),
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
      machines: { socketPath, enrolled: [enrollment] },
    },
    llm: {
      resolveProviderModel: async (model) => ({ id: model.id, name: model.id, providerID: model.provider }),
      run: async (input: RunInput, sink: Sink) => {
        if (input.trace.sessionId.startsWith("delegation-")) {
          // Each worker answers with the instruction it was actually given, so
          // a cell that dropped or duplicated one would be visible.
          const asked = (input.messages.at(-1)?.parts ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(" ");
          sink.onMessage(message(input, `done(${asked.replace(/^.*?: /, "")})`));
          return { type: "stop" };
        }

        residentTurns.push(input.trace.sessionId);
        const offered = (input.tools ?? []).map((tool) => tool.name).sort();
        const executed = await input.toolExecutor?.({
          id: "call-1",
          tool: "run_code",
          input: {
            machineId: MACHINE_ID,
            code: [
              "answers = [",
              "  tool.delegate(instruction=f'check {name}', mode='ask', scope='inline', timeoutMs=5000)",
              "  for name in ('lint', 'types', 'tests')",
              "]",
              "'; '.join(answers)",
            ].join("\n"),
            timeoutMs: 20_000,
          },
        });
        sink.onMessage(message(input, `offered=[${offered.join(",")}] cell=${executed?.output ?? "nothing"}`));
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;

  daemon = await attachMachineDaemon({
    socketPath,
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  });
  expect(daemon.attachment.status).toBe("attached");

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
  });
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply arrived")), 30_000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
  ws.send(JSON.stringify({ type: "message", text: "check everything" }));

  const answer = (JSON.parse(await reply) as { text: string }).text;
  ws.close();

  // The machine was attached, so the machine-placed tool was offered.
  expect(answer).toContain("offered=[delegate,run_code]");
  // Three workers ran and their answers came back inside the cell. The value
  // is the cell's final expression as Python rendered it, quotes included.
  expect(answer).toContain("done(check lint); done(check types); done(check tests)");
  // One Resident turn, not three: that is what code mode bought.
  expect(residentTurns).toHaveLength(1);
}, 60_000);

test("the machine tool is not offered while nothing is attached", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-code-mode-off-"));
  directories.push(directory);
  let offered: string[] = [];

  const app = await startOpenOmni({
    config: {
      dbPath: join(directory, "chat.db"),
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
      machines: { socketPath: join(directory, "machines.sock"), enrolled: [enrollment] },
    },
    llm: {
      resolveProviderModel: async (model) => ({ id: model.id, name: model.id, providerID: model.provider }),
      run: async (input: RunInput, sink: Sink) => {
        offered = (input.tools ?? []).map((tool) => tool.name);
        // Naming it anyway must be refused, not served: what the fold declined
        // to offer it also declines to run.
        const forced = await input.toolExecutor?.({
          id: "call-1",
          tool: "run_code",
          input: { machineId: MACHINE_ID, code: "1", timeoutMs: 1000 },
        });
        sink.onMessage(message(input, `forced=${forced?.output ?? "nothing"}`));
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
  });
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply arrived")), 15_000);
    ws.addEventListener("message", (event) => { clearTimeout(timer); resolve(String(event.data)); }, { once: true });
  });
  ws.send(JSON.stringify({ type: "message", text: "run something" }));

  const answer = (JSON.parse(await reply) as { text: string }).text;
  ws.close();

  expect(offered).toEqual(["delegate"]);
  // Refused by the one gate that owns this refusal, naming what was missing.
  expect(answer).toContain('tool "run_code" requires capabilities no attached target holds: kernel.py');
}, 30_000);
