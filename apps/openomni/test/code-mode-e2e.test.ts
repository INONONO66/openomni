import { expect, test } from "bun:test";
import { Bus } from "@openomni/telemetry";
import type { RunInput, Sink } from "@openomni/llm";
import { attachMachineDaemon, createMachineHost, type MachineDaemon } from "@openomni/machines";
import { Placement } from "@openomni/placement";
import type { Artifact, Machine } from "@openomni/protocol";
import type { DelegationOrigin } from "../src/delegation/admission";
import type { DelegationKernel } from "../src/delegation/kernel";
import type { ArtifactsPort } from "../src/tools/artifacts";
import { catalogEntries, type CatalogPorts } from "../src/tools/catalog";
import { createCellRegistry } from "../src/tools/cell-registry";
import { createDispatcher, HOST_TARGET } from "../src/tools/dispatch";
import { type CellPorts, runCodeToolExecutor } from "../src/tools/run-code";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { socketPath as testSocketPath } from "./helpers/socket-path";
import { nextMessage, openSocket } from "./helpers/ws";

const WS_TOKEN = "code-mode-e2e-token";
const MACHINE_ID = "alpha";

let daemon: MachineDaemon | undefined;
const suite = residentSuite(() => {
  daemon?.close();
  daemon = undefined;
});

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

  const app = await suite.boot({
    config: suite.config("openomni-code-mode-", {
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
      machines: { socketPath, enrolled: [enrollment] },
    }),
    llm: {
      resolveProviderModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        if (input.trace.sessionId.startsWith("delegation-")) {
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
              "'; '.join(answers) + ' | body: ' + tool.machines()",
            ].join("\n"),
            timeoutMs: 20_000,
          },
        });
        const listed = await input.toolExecutor?.({ id: "call-2", tool: "machines", input: {} });
        sink.onMessage(
          assistantMessage(input, {
            text: `offered=[${offered.join(",")}] cell=${executed?.output ?? "nothing"} machines=${listed?.output ?? "nothing"}`,
          }),
        );
        return { type: "stop" };
      },
    },
  });

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

  const ws = await openSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  const reply = nextMessage(ws, 30_000);
  ws.send(JSON.stringify({ type: "message", text: "check everything" }));

  const answer = (JSON.parse(String((await reply).data)) as { text: string }).text;
  ws.close();

  // The machine was attached, so the machine-placed tool was offered.
  expect(answer).toContain("offered=[await_delegation,cancel_delegation,complete_work,delegate,llm,machines,memory,read_artifact,run_code,work_items,write_artifact]");
  // Three workers ran and their answers came back inside the cell. The value
  // is the cell's final expression as Python rendered it, quotes included.
  expect(answer).toContain("done(check lint); done(check types); done(check tests)");
  // One Resident turn, not three: that is what code mode bought.
  expect(residentTurns).toHaveLength(1);
  // The composed machines port read the live attachment table, not a snapshot.
  expect(answer).toContain(`machines=${MACHINE_ID} — attached, may: kernel.py`);
  // The cell door offers the same discovery tool — production wiring, not a test-built catalog.
  expect(answer).toContain(`| body: ${MACHINE_ID} — attached, may: kernel.py`);
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
      resolveProviderModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        offered = (input.tools ?? []).map((tool) => tool.name);
        // Naming it anyway must be refused, not served: what the fold declined
        // to offer it also declines to run.
        const forced = await input.toolExecutor?.({
          id: "call-1",
          tool: "run_code",
          input: { machineId: MACHINE_ID, code: "1", timeoutMs: 1000 },
        });
        const listed = await input.toolExecutor?.({ id: "call-2", tool: "machines", input: {} });
        sink.onMessage(
          assistantMessage(input, {
            text: `forced=${forced?.output ?? "nothing"} machines=${listed?.output ?? "nothing"}`,
          }),
        );
        return { type: "stop" };
      },
    },
  });

  const ws = await openSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  const reply = nextMessage(ws, 15_000);
  ws.send(JSON.stringify({ type: "message", text: "run something" }));

  const answer = (JSON.parse(String((await reply).data)) as { text: string }).text;
  ws.close();

  expect(offered).toEqual(["delegate", "await_delegation", "cancel_delegation", "machines", "memory", "work_items", "complete_work", "llm", "write_artifact", "read_artifact"]);
  // Refused by the one gate that owns this refusal, naming what was missing.
  expect(answer).toContain('tool "run_code" requires capabilities no attached target holds: kernel.py');
  // Enrolled-but-detached is honestly reported, so the model knows why run_code is absent.
  expect(answer).toContain(`machines=${MACHINE_ID} — enrolled, not attached right now`);
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

  const slow = host.runCell(MACHINE_ID, {
    cellId: "AAA",
    code: "tool.hold()",
    timeoutMs: 15_000,
    tenant: "tenant-one",
  });
  const forging = await host.runCell(MACHINE_ID, {
    cellId: "BBB",
    // The call carries no id of its own; naming one changes nothing.
    code: "tool.delegate(cellId='AAA', instruction='borrow')",
    timeoutMs: 15_000,
    tenant: "tenant-two",
  });
  await slow;
  host.close();

  // Completion itself proves the overlap: on one interpreter AAA's hold would
  // wait forever for a BBB that cannot start until AAA settles.
  expect([...served].sort()).toEqual(["delegate@BBB", "hold@AAA"]);
  expect(forging.status).toBe("completed");
}, 40_000);

const CELL_ORIGIN: DelegationOrigin = { role: "resident", depth: 0, sessionId: "cell-e2e" };

/**
 * A real host+daemon pair whose cells go through the production run_code
 * executor, with the catalog's ports swapped for fakes — the same seam
 * startOpenOmni wires at boot, exercised without booting the app.
 */
async function startCellHarness(ports: CatalogPorts) {
  const socketPath = testSocketPath();
  const registry = createCellRegistry();
  const host = await createMachineHost({
    socketPath,
    enrollment: (machineId) => (machineId === MACHINE_ID ? enrollment : undefined),
    events: Bus,
    now: () => Date.now(),
    callTool: registry.callTool,
  });
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
  const cells: CellPorts = {
    registry,
    runCell: (machineId, request) => host.runCell(machineId, request),
    toolsFor: (origin) => catalogEntries(ports, origin),
    newCellId: () => crypto.randomUUID(),
  };
  const execute = runCodeToolExecutor(cells, CELL_ORIGIN);
  return {
    host,
    run: (code: string) => execute({ machineId: MACHINE_ID, code, timeoutMs: 15_000 }),
    runWith: (origin: DelegationOrigin, code: string) =>
      runCodeToolExecutor(cells, origin)({ machineId: MACHINE_ID, code, timeoutMs: 15_000 }),
  };
}

test("cells from different sessions never share interpreter state", async () => {
  const { host, runWith } = await startCellHarness({ llm: async () => "ok" });
  const sessionA: DelegationOrigin = { role: "resident", depth: 0, sessionId: "session-a" };
  const sessionB: DelegationOrigin = { role: "resident", depth: 0, sessionId: "session-b" };

  await runWith(sessionA, "shared = 'mine'\n'set'");
  const sameSession = await runWith(sessionA, "shared");
  const otherSession = await runWith(sessionB, "shared");
  host.close();

  // Same session: state persists. Other session: a separate interpreter, so
  // the name simply does not exist there.
  expect(sameSession).toContain("mine");
  expect(otherSession).toContain("the cell raised");
  expect(otherSession).toContain("NameError");
}, 40_000);

test("a cell's llm(prompt) is answered by the LlmPort wired into the catalog", async () => {
  const prompts: string[] = [];
  const { host, run } = await startCellHarness({
    llm: async (prompt) => {
      prompts.push(prompt);
      return `answered: ${prompt}`;
    },
  });

  const output = await run("llm(prompt='summarize the ledger in one word')");
  host.close();

  expect(prompts).toEqual(["summarize the ledger in one word"]);
  // The cell's final expression is repr'd by the driver, quotes included.
  expect(output).toContain("answered: summarize the ledger in one word");
}, 40_000);

test("a failing llm call raises ToolError inside the cell instead of returning failure text", async () => {
  const { host, run } = await startCellHarness({
    llm: async () => {
      throw new Error("llm failed: provider on fire");
    },
  });

  const output = await run(
    [
      "try:",
      "    llm(prompt='doomed')",
      "    outcome = 'returned as data'",
      "except ToolError as error:",
      "    outcome = 'raised: ' + str(error)",
      "outcome",
    ].join("\n"),
  );
  host.close();

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
  const { host, run } = await startCellHarness({
    llm: async (prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) releaseBoth?.();
      // A serialized door would wedge the first call here; the bounded wait
      // turns that into a failure rather than a hang.
      await Promise.race([
        bothArrived,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("tool calls were serialized")), 10_000),
        ),
      ]);
      inFlight -= 1;
      return `answered(${prompt})`;
    },
  });

  const output = await run(
    [
      "results = parallel([",
      "  lambda: tool.llm(prompt='first'),",
      "  lambda: tool.llm(prompt='second'),",
      "])",
      "'; '.join(results)",
    ].join("\n"),
  );
  host.close();

  // Both calls were in flight at once — the kernel's concurrent door, not luck.
  expect(maxInFlight).toBe(2);
  expect(output).toContain("answered(first); answered(second)");
}, 40_000);

test("the cell door offers host-placed delegate and machines, folding out machine-placed run_code", () => {
  const ports: CatalogPorts = {
    delegation: {} as DelegationKernel,
    cells: {} as CellPorts,
    machines: () => [],
  };
  // The exact fold run-code.ts's cellDoor performs: the whole catalog,
  // resolved against the brain alone.
  const offerable = Placement.resolveTools(
    createDispatcher(catalogEntries(ports, CELL_ORIGIN)).specs,
    [HOST_TARGET],
  )
    .filter((decision) => decision.offerable)
    .map((decision) => decision.tool.name);

  expect(offerable).toContain("delegate");
  expect(offerable).toContain("machines");
  // A cell already runs on a machine, so the machine-placed tool drops out.
  expect(offerable).not.toContain("run_code");

  // Without its port the machines tool is absent from the catalog entirely,
  // not merely unofferable.
  const withoutPort = catalogEntries({ delegation: {} as DelegationKernel }, CELL_ORIGIN).map(
    (entry) => entry.spec.name,
  );
  expect(withoutPort).toContain("delegate");
  expect(withoutPort).not.toContain("machines");
});

test("write_artifact stores from inside a cell and read_artifact fetches it back by id", async () => {
  const rows = new Map<string, { meta: Artifact.Meta; content: string }>();
  const artifacts: ArtifactsPort = {
    store: (_sessionId, meta, content) => {
      rows.set(meta.id, { meta, content });
    },
    get: (artifactId) => rows.get(artifactId) ?? null,
  };
  const { host, run } = await startCellHarness({ artifacts });

  const output = await run(
    [
      "stored = tool.write_artifact(name='dataset', content='x' * 4000)",
      "artifact_id = stored.split(': ', 1)[1]",
      "fetched = tool.read_artifact(artifactId=artifact_id)",
      "stored + ' | fetched_len=' + str(len(fetched)) + ' | match=' + str(fetched == 'x' * 4000)",
    ].join("\n"),
  );
  host.close();

  expect(output).toContain("artifact stored: ");
  expect(output).toContain("fetched_len=4000");
  expect(output).toContain("match=True");
  // The content itself never came back through the conversation.
  expect(output).not.toContain("x".repeat(4000));
  const stored = [...rows.values()];
  expect(stored).toHaveLength(1);
  expect(stored[0]?.meta.sessionId).toBe(CELL_ORIGIN.sessionId);
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
  daemon = await attachMachineDaemon({
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
  expect(host.attached(MACHINE_ID)).toEqual(["fs.read"]);
  host.close();
}, 30_000);
