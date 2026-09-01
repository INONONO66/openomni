import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { attachMachineDaemon, type MachineDaemon } from "@openomni/machines";
import type { Machine } from "@openomni/protocol";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { socketPath as testSocketPath } from "./helpers/socket-path";
import { nextMessage, openSocket } from "./helpers/ws";

const WS_TOKEN = "machine-fs-e2e-token";
const MACHINE_ID = "alpha";

let daemon: MachineDaemon | undefined;
const suite = residentSuite(() => {
  daemon?.close();
  daemon = undefined;
});

const enrollment: Machine.Enrollment = {
  machineId: MACHINE_ID,
  name: "the laptop",
  allowedCapabilities: ["fs.read", "kernel.py"],
  allowedExports: ["notes"],
  enrolledAt: 0,
};

/**
 * The export as it exists on disk: one file to read, one subdirectory, and a
 * symlink pointing OUT of the export — the escape the daemon must refuse
 * after resolution, not before.
 */
function exportRoot(directory: string): string {
  const root = join(directory, "notes");
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(join(root, "greeting.txt"), "hello from the machine");
  writeFileSync(join(root, "plans", "q3.md"), "ship the vfs");
  writeFileSync(join(directory, "secret.txt"), "not yours");
  symlinkSync(join(directory, "secret.txt"), join(root, "escape.txt"));
  return root;
}

/**
 * The real composition: startOpenOmni's own machine host, catalog, and cell
 * door, with a real daemon serving a real temp directory. `answer` runs one
 * Resident turn whose fake model executes the tool calls the test names and
 * reports each output verbatim.
 */
async function bootFsApp(
  prefix: string,
  options: {
    readonly enrolled?: readonly Machine.Enrollment[];
    readonly attach?: boolean;
    readonly exportName?: string;
  } = {},
) {
  const socketPath = testSocketPath();
  const directory = suite.tempDir(prefix);
  const root = exportRoot(directory);
  let calls: { tool: string; input: Record<string, unknown> }[] = [];
  let offered: string[] = [];

  const app = await suite.boot({
    config: suite.config(prefix, {
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "machine-fs-test", apiKey: "test-key" },
      machines: { socketPath, enrolled: options.enrolled ?? [enrollment] },
    }),
    llm: {
      resolveProviderModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        offered = (input.tools ?? []).map((tool) => tool.name);
        const outputs: string[] = [];
        for (const [index, call] of calls.entries()) {
          const result = await input.toolExecutor?.({
            id: `call-${index}`,
            tool: call.tool,
            input: call.input,
          });
          outputs.push(`<<${result?.output ?? "nothing"}>>`);
        }
        sink.onMessage(assistantMessage(input, { text: outputs.join("\n") }));
        return { type: "stop" };
      },
    },
  });

  if (options.attach !== false) {
    daemon = await attachMachineDaemon({
      socketPath,
      offer: {
        machineId: MACHINE_ID,
        offeredCapabilities: ["fs.read", "kernel.py"],
        exports: [{ name: options.exportName ?? "notes" }],
        daemonVersion: "test",
        platform: "test",
        offeredAt: 0,
      },
      fsExports: new Map([[options.exportName ?? "notes", root]]),
    });
    expect(daemon.attachment.status).toBe("attached");
  }

  return {
    root,
    async answer(toolCalls: { tool: string; input: Record<string, unknown> }[]) {
      calls = toolCalls;
      const ws = await openSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
      const reply = nextMessage(ws, 30_000);
      ws.send(JSON.stringify({ type: "message", text: "read the machine" }));
      const text = (JSON.parse(String((await reply).data)) as { text: string }).text;
      ws.close();
      return text;
    },
    offered: () => offered,
  };
}

/** Model door: the three tools, dispatched through the composed catalog. */
test("the model reads, lists, and stats an attached machine's export", async () => {
  const app = await bootFsApp("openomni-fs-e2e-");

  const answer = await app.answer([
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/notes/greeting.txt` } },
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/notes/plans/q3.md` } },
    { tool: "fs_list", input: { path: `/machines/${MACHINE_ID}/notes` } },
    { tool: "fs_stat", input: { path: `/machines/${MACHINE_ID}/notes/greeting.txt` } },
    { tool: "machines", input: {} },
  ]);

  // The attachment carried an effective export, so the whole surface is live.
  expect(app.offered()).toContain("fs_read");
  expect(app.offered()).toContain("fs_list");
  expect(app.offered()).toContain("fs_stat");

  expect(answer).toContain("<<hello from the machine>>");
  expect(answer).toContain("<<ship the vfs>>");
  // Listing shows the subdirectory, the file with its size, and the symlink
  // AS a symlink — an entry the read surface will refuse to follow out.
  expect(answer).toContain("link  escape.txt");
  expect(answer).toContain("file  greeting.txt  22 bytes");
  expect(answer).toContain("dir   plans");
  expect(answer).toContain("<<file  22 bytes  modified ");
  // Discovery names the path the tools take, not a bare export name.
  expect(answer).toContain(`${MACHINE_ID} — attached, may: fs.read, kernel.py; files: /machines/${MACHINE_ID}/notes`);
}, 60_000);

/** Cell door: the same catalog, reached from inside Python. */
test("a cell reads a machine file through tool.fs_read", async () => {
  const app = await bootFsApp("openomni-fs-cell-");

  const answer = await app.answer([
    {
      tool: "run_code",
      input: {
        machineId: MACHINE_ID,
        code: [
          `text = tool.fs_read(path='/machines/${MACHINE_ID}/notes/greeting.txt')`,
          `listing = tool.fs_list(path='/machines/${MACHINE_ID}/notes')`,
          "text + ' | entries=' + str(len(listing.splitlines()))",
        ].join("\n"),
        timeoutMs: 20_000,
      },
    },
  ]);

  expect(answer).toContain("hello from the machine | entries=3");
}, 60_000);

/**
 * A refusal must reach the cell as an EXCEPTION, not as text that reads like
 * file content — otherwise cell code stores the refusal and carries on.
 */
test("a refused read raises ToolError inside a cell instead of returning refusal text", async () => {
  const app = await bootFsApp("openomni-fs-cell-raise-");

  const answer = await app.answer([
    {
      tool: "run_code",
      input: {
        machineId: MACHINE_ID,
        code: [
          "try:",
          `    tool.fs_read(path='/machines/${MACHINE_ID}/notes/escape.txt')`,
          "    outcome = 'returned as data'",
          "except ToolError as error:",
          "    outcome = 'raised: ' + str(error)",
          "outcome",
        ].join("\n"),
        timeoutMs: 20_000,
      },
    },
  ]);

  expect(answer).toContain("raised: ");
  expect(answer).toContain("path escapes export");
  expect(answer).not.toContain("returned as data");
  expect(answer).not.toContain("not yours");
}, 60_000);

/** Every boundary, as the exact sentence the agent would read. */
test("the adversarial paths each refuse with the boundary that held", async () => {
  const app = await bootFsApp("openomni-fs-adversarial-");

  const answer = await app.answer([
    // A symlink out of the export: resolved, then refused. The daemon owns
    // this one — the host never sees the target path.
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/notes/escape.txt` } },
    // An export the daemon never offered: the host refuses before the wire.
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/private/keys` } },
    // `..` never reaches a machine at all — the schema refuses it.
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/notes/../../etc/passwd` } },
    // A machine that is not attached.
    { tool: "fs_list", input: { path: "/machines/ghost/notes" } },
    // A path outside the namespace entirely.
    { tool: "fs_stat", input: { path: "/etc/passwd" } },
    // A directory read as a file.
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/notes/plans` } },
    // Nothing there.
    { tool: "fs_stat", input: { path: `/machines/${MACHINE_ID}/notes/absent.txt` } },
  ]);

  expect(answer).toContain(
    `<</machines/${MACHINE_ID}/notes/escape.txt refused: path escapes export: escape.txt>>`,
  );
  expect(answer).toContain(
    `<</machines/${MACHINE_ID}/private/keys refused: export is not available: private>>`,
  );
  expect(answer).toContain(
    "<<path must be relative to the export root, with no .. segment or NUL>>",
  );
  expect(answer).toContain("<<machine ghost is not attached right now>>");
  expect(answer).toContain(
    '<<path must start with /machines/<machineId>/<export>: "/etc/passwd">>',
  );
  expect(answer).toContain(
    `<</machines/${MACHINE_ID}/notes/plans refused: path is not a file: plans>>`,
  );
  expect(answer).toContain(
    `<</machines/${MACHINE_ID}/notes/absent.txt refused: path not found: absent.txt>>`,
  );
  // The escaped file's contents never appeared anywhere in the answer.
  expect(answer).not.toContain("not yours");
}, 60_000);

/**
 * The Owner's allowlist is the ceiling on BOTH sides of the fold: an export
 * the daemon offers but the enrollment never named reaches nothing.
 */
test("an export the Owner never allowed is refused even though the daemon offers it", async () => {
  const app = await bootFsApp("openomni-fs-unallowed-", { exportName: "secrets" });

  const answer = await app.answer([
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/secrets/greeting.txt` } },
    { tool: "machines", input: {} },
  ]);

  expect(answer).toContain(
    `<</machines/${MACHINE_ID}/secrets/greeting.txt refused: export is not available: secrets>>`,
  );
  // And discovery says so: attached, capable, but no export reaches anything.
  expect(answer).toContain(`${MACHINE_ID} — attached, may: fs.read, kernel.py>>`);
}, 60_000);

/**
 * Fail-closed at the composition root: an Owner who published no export gets
 * no fs surface at all, rather than tools that can only ever refuse.
 */
test("no allowed export means no fs tools in the catalog", async () => {
  const app = await bootFsApp("openomni-fs-none-", {
    enrolled: [
      {
        machineId: MACHINE_ID,
        name: "the laptop",
        allowedCapabilities: ["fs.read", "kernel.py"],
        enrolledAt: 0,
      },
    ],
  });

  const answer = await app.answer([
    { tool: "fs_read", input: { path: `/machines/${MACHINE_ID}/notes/greeting.txt` } },
  ]);

  expect(app.offered()).not.toContain("fs_read");
  expect(app.offered()).not.toContain("fs_list");
  expect(app.offered()).not.toContain("fs_stat");
  expect(answer).toContain("<<unknown tool: fs_read>>");
}, 60_000);
