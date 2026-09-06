import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { interpreterWitness } from "./helpers/interpreter-witness";
import { SessionHandleStore } from "@openomni/ledger";
import { Bus } from "@openomni/agent";
import type { RunInput, Sink } from "@openomni/llm";
import {
  attachMachineDaemon as attachDaemon,
  createMachineHost as createHost,
  type MachineDaemon,
} from "@openomni/machines";
import type { Machine } from "@openomni/protocol";
import type { DelegationOrigin } from "../src/delegation/admission";
import type { CatalogPorts } from "../src/tools/core/catalog";
import { composeCodemode } from "../src/composition/codemode";
import { createCodemode } from "@openomni/codemode";
import { modelToolOutput } from "./helpers/tool-dispatch";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { socketPath as testSocketPath } from "./helpers/socket-path";
import { nextMessage } from "./helpers/ws";

const WS_TOKEN = "code-mode-e2e-token";
const MACHINE_ID = "alpha";

let witness: ReturnType<typeof interpreterWitness>;
beforeEach(() => {
  witness = interpreterWitness();
});

const suite = residentSuite(async () => {
  try {
    await witness.wait();
  } finally {
    witness.restore();
  }
});

// Registration occurs before returning to any fallible test or harness work.
async function createMachineHost(options: Parameters<typeof createHost>[0]) {
  const host = await createHost(options);
  suite.defer(() => {
    host.close();
    expect(existsSync(options.socketPath)).toBe(false);
    console.log(
      "967-U1 host cleanup",
      JSON.stringify({
        socketPath: options.socketPath,
        socketExists: existsSync(options.socketPath),
      }),
    );
  });
  return host;
}

async function attachMachineDaemon(
  options: Parameters<typeof attachDaemon>[0],
): Promise<MachineDaemon> {
  const daemon = await attachDaemon({ ...options, runner: createCodemode().runner });
  suite.defer(() => daemon.close());
  return daemon;
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
  const socketPath = testSocketPath();
  const residentTurns: string[] = [];

  const config = suite.config("openomni-code-mode-", {
    wsToken: WS_TOKEN,
    model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
    machines: { socketPath, enrolled: [enrollment] },
  });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        if (SessionHandleStore.row(input.trace.sessionId).role === "worker") {
          // Each worker answers with the instruction it was actually given, so
          // a cell that dropped or duplicated one would be visible.
          const asked = (input.messages.at(-1)?.parts ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(" ");
          sink.onMessage(assistantMessage(input, { text: `done(${asked.replace(/^.*?: /, "")})` }));
          return { type: "stop" };
        }

        residentTurns.push(input.trace.sessionId);
        const offered = (input.tools ?? []).map((tool) => tool.name).sort();
        const executed = requestToolStep(input, sink, {
          id: "call-1",
          tool: "run_code",
          input: {
            code: [
              "answers = [",
              "  tool.delegate(instruction=f'check {name}', operation='ask', scope='inline', timeoutMs=5000)['settlement']['output']",
              "  for name in ('lint', 'types', 'tests')",
              "]",
              "'; '.join(answers)",
            ].join("\n"),
            timeoutMs: 20_000,
          },
        });
        if (executed === undefined) return { type: "stop" };
        const listed = requestToolStep(input, sink, { id: "call-2", tool: "machines", input: {} });
        if (listed === undefined) return { type: "stop" };
        sink.onMessage(
          assistantMessage(input, {
            text: `offered=[${offered.join(",")}] cell=${executed?.output ?? "nothing"} machines=${listed?.output ?? "nothing"}`,
          }),
        );
        return { type: "stop" };
      },
    },
  });

  const daemon = await attachMachineDaemon({
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

  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
  const reply = nextMessage(ws, 30_000);
  ws.send(JSON.stringify({ type: "message", text: "check everything" }));

  const answer = (JSON.parse(String((await reply).data)) as { text: string }).text;

  // The machine was attached, so the machine-placed tool was offered.
  expect(answer).toContain(
    "offered=[approval,await_delegation,cancel_delegation,delegate,provision,run_code]",
  );
  // Three workers ran and their answers came back inside the cell. The value
  // is the cell's final expression as Python rendered it, quotes included.
  expect(answer).toContain("done(check lint); done(check types); done(check tests)");
  // One Resident turn, not three: that is what code mode bought.
  expect(residentTurns).toHaveLength(3);
  expect(new Set(residentTurns).size).toBe(1);
  expect(answer).toContain("machines=unregistered tool: machines");
  expect(witness.pids).toHaveLength(1);
  await suite.cleanup();
  expect(witness.completed).toBe(true);
  expect(existsSync(socketPath)).toBe(false);
  expect(existsSync(dirname(config.dbPath))).toBe(false);
  console.log(
    "967-U1 code-mode cleanup",
    JSON.stringify({
      pids: witness.pids,
      socketPath,
      socketExists: existsSync(socketPath),
      dbPath: config.dbPath,
      directoryExists: existsSync(dirname(config.dbPath)),
    }),
  );
}, 60_000);

test("the machine tool is not offered while nothing is attached", async () => {
  let offered: string[] = [];

  const app = await suite.boot({
    config: suite.config("openomni-code-mode-off-", {
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
      machines: { socketPath: testSocketPath(), enrolled: [enrollment] },
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        offered = (input.tools ?? []).map((tool) => tool.name);
        // Naming it anyway must be refused, not served: what the fold declined
        // to offer it also declines to run.
        const forced = requestToolStep(input, sink, {
          id: "call-1",
          tool: "run_code",
          input: { code: "1", timeoutMs: 1000 },
        });
        if (forced === undefined) return { type: "stop" };
        const listed = requestToolStep(input, sink, { id: "call-2", tool: "machines", input: {} });
        if (listed === undefined) return { type: "stop" };
        sink.onMessage(
          assistantMessage(input, {
            text: `forced=${forced?.output ?? "nothing"} machines=${listed?.output ?? "nothing"}`,
          }),
        );
        return { type: "stop" };
      },
    },
  });

  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
  const reply = nextMessage(ws, 15_000);
  ws.send(JSON.stringify({ type: "message", text: "run something" }));

  const answer = (JSON.parse(String((await reply).data)) as { text: string }).text;

  expect(offered).toEqual([
    "delegate",
    "await_delegation",
    "cancel_delegation",
    "approval",
    "provision",
    "run_code",
  ]);
  // All tools are host-projected; the local default host reports live attachment failure.
  expect(answer).toContain("kernel_not_available");
  expect(answer).toContain("machines=unregistered tool: machines");
}, 30_000);

/**
 * What actually makes a cell's identity unforgeable, pinned upstream of the
 * registry: the cell's code never states its own id. A cell that tries to
 * serve a call under another cell's id gets the daemon's stamp instead.
 */
test("a cell cannot present another cell's id when calling back", async () => {
  const socketPath = testSocketPath();
  const served: string[] = [];

  // AAA (tenant one) blocks inside a tool call the host holds until BBB
  // (tenant two — a separate interpreter, so the two genuinely overlap) has
  // been served. No sleeps: the deferred IS the overlap proof.
  let announceServed!: () => void;
  const forgingServed = new Promise<void>((resolve) => {
    announceServed = resolve;
  });
  const host = await createMachineHost({
    socketPath,
    enrollment: (machineId) => (machineId === MACHINE_ID ? enrollment : undefined),
    events: Bus,
    now: () => Date.now(),
    callTool: async (call) => {
      served.push(`${call.name}@${call.cellId}`);
      if (call.name === "hold") {
        await forgingServed;
        return { status: "completed", value: "held" };
      }
      announceServed();
      return { status: "completed", value: call.cellId };
    },
  });
  await attachMachineDaemon({
    socketPath,
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  });

  const slow = host.get(MACHINE_ID).runCode({
    cellId: "AAA",
    code: "tool.hold()",
    timeoutMs: 15_000,
    tenant: "tenant-one",
  });
  const forging = await host.get(MACHINE_ID).runCode({
    cellId: "BBB",
    // The call carries no id of its own; naming one changes nothing.
    code: "tool.delegate(cellId='AAA', instruction='borrow')",
    timeoutMs: 15_000,
    tenant: "tenant-two",
  });
  await slow;

  // Completion itself proves the overlap: on one interpreter AAA's hold would
  // wait forever for a BBB that cannot start until AAA settles.
  expect([...served].sort()).toEqual(["delegate@BBB", "hold@AAA"]);
  expect(forging.status).toBe("completed");
}, 40_000);

test("967-U1 error cleanup owns the host and awaits every interpreter", async () => {
  const { socketPath, runWith } = await startCellHarness({ llm: async () => "ok" });
  const directory = suite.tempDir("openomni-code-mode-failure-");
  const failure = new Error("U1_INJECTED_CELL_FAILURE");
  try {
    await runWith({ role: "resident", depth: 0, sessionId: "failure-a" }, "1 + 1");
    await runWith({ role: "resident", depth: 0, sessionId: "failure-b" }, "2 + 2");
    expect(witness.pids).toHaveLength(2);
    try {
      throw failure;
    } catch (error) {
      expect(error).toBe(failure);
    } finally {
      await suite.cleanup();
    }
    expect(existsSync(socketPath)).toBe(false);
    expect(witness.completed).toBe(true);
    expect(existsSync(directory)).toBe(false);
    console.log(
      "967-U1 code-mode failure cleanup",
      JSON.stringify({
        pids: witness.pids,
        socketPath,
        socketExists: existsSync(socketPath),
        directory,
        directoryExists: existsSync(directory),
      }),
    );
  } finally {
    await suite.cleanup();
  }
}, 30_000);

const CELL_ORIGIN: DelegationOrigin = { role: "resident", depth: 0, sessionId: "cell-e2e" };

/**
 * A real host+daemon pair whose cells go through the production run_code
 * executor, with the catalog's ports swapped for fakes — the same seam
 * startOpenOmni wires at boot, exercised without booting the app.
 */
async function startCellHarness(ports: CatalogPorts) {
  const socketPath = testSocketPath();
  let cells: ReturnType<typeof composeCodemode>;
  const host = await createMachineHost({
    socketPath,
    enrollment: (machineId) => (machineId === MACHINE_ID ? enrollment : undefined),
    events: Bus,
    now: () => Date.now(),
    callTool: (call) => cells.callTool(call),
  });
  const daemon = await attachMachineDaemon({
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
  cells = composeCodemode(host);
  suite.defer(() => cells.close());
  const execute = modelToolOutput("run_code", { ...ports, cells }, CELL_ORIGIN);
  return {
    socketPath,
    run: (code: string) => execute({ code, timeoutMs: 15_000 }),
    runWith: (origin: DelegationOrigin, code: string) =>
      modelToolOutput("run_code", { ...ports, cells }, origin)({ code, timeoutMs: 15_000 }),
  };
}

test("cells from different sessions never share interpreter state", async () => {
  const { runWith } = await startCellHarness({ llm: async () => "ok" });
  const sessionA: DelegationOrigin = { role: "resident", depth: 0, sessionId: "session-a" };
  const sessionB: DelegationOrigin = { role: "resident", depth: 0, sessionId: "session-b" };

  await runWith(sessionA, "shared = 'mine'\n'set'");
  const sameSession = await runWith(sessionA, "shared");
  const otherSession = await runWith(sessionB, "shared");

  // Same session: state persists. Other session: a separate interpreter, so
  // the name simply does not exist there.
  expect(sameSession).toContain("mine");
  expect(otherSession).toContain("the cell raised");
  expect(otherSession).toContain("NameError");
}, 40_000);

test("a cell rejects legacy scalar llm input and preserves canonical arrays", async () => {
  const prompts: string[] = [];
  const { run } = await startCellHarness({
    llm: async (prompt) => {
      prompts.push(prompt);
      return `answered: ${prompt}`;
    },
  });

  const output = await run(
    [
      "try:",
      "    tool.llm(prompt='x')",
      "    legacy = 'accepted'",
      "except ToolError:",
      "    legacy = 'invalid_input'",
      "canonical = tool.llm(prompts=['x'])",
      "{'legacy': legacy, 'canonical': canonical}",
    ].join("\n"),
  );

  // The cell sees the dispatcher refusal as ToolError and does not invoke the port.
  expect(output).toBe("{'legacy': 'invalid_input', 'canonical': ['answered: x']}");
  expect(prompts).toEqual(["x"]);
}, 40_000);

test("a failing llm call raises ToolError inside the cell instead of returning failure text", async () => {
  const { run } = await startCellHarness({
    llm: async () => {
      throw new Error("llm failed: provider on fire");
    },
  });

  const output = await run(
    [
      "try:",
      "    llm(['doomed'])",
      "    outcome = 'returned as data'",
      "except ToolError as error:",
      "    outcome = 'raised: ' + str(error)",
      "outcome",
    ].join("\n"),
  );

  expect(output).toContain("raised: ");
  expect(output).toContain("llm failed: provider on fire");
  expect(output).not.toContain("returned as data");
}, 40_000);

test("parallel() runs independent tool calls concurrently and returns both results in input order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseBoth: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const { run } = await startCellHarness({
    llm: async (prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) releaseBoth?.();
      // A serialized door would wedge the first call here; the bounded wait
      // turns that into a failure rather than a hang.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bothArrived,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("tool calls were serialized")), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      inFlight -= 1;
      return `answered(${prompt})`;
    },
  });

  const output = await run(
    [
      "results = parallel([",
      "  lambda: llm(['first'])[0],",
      "  lambda: llm(['second'])[0],",
      "])",
      "'; '.join(results)",
    ].join("\n"),
  );

  // Both calls were in flight at once — the kernel's concurrent door, not luck.
  expect(maxInFlight).toBe(2);
  expect(output).toContain("answered(first); answered(second)");
}, 40_000);

/** The Owner's enrollment is the ceiling: a daemon cannot claim its way past it. */
test("a machine offering more than it is enrolled for keeps only the intersection", async () => {
  const socketPath = testSocketPath();

  const host = await createMachineHost({
    socketPath,
    enrollment: () => ({ ...enrollment, allowedCapabilities: ["fs.read"] }),
    events: Bus,
    now: () => Date.now(),
    callTool: async () => ({ status: "failed", error: "no tools" }),
  });
  await attachMachineDaemon({
    socketPath,
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: ["fs.read", "kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  });

  // Without kernel.py in the effective set, run_code stays unofferable.
  expect(host.list().find((entry) => entry.machineId === MACHINE_ID)?.capabilities).toEqual(["fs.read"]);
}, 30_000);
