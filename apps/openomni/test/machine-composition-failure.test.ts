import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import * as Machines from "@openomni/machines";
import type { Machine } from "@openomni/protocol";
import * as Codemode from "../src/composition/codemode";
import { startOpenOmni } from "../src/index";
import { runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";

test("the app machine host translates a codemode failure at its callback boundary", async () => {
  const createHost = Machines.createMachineHost;
  const compose = Codemode.composeCodemode;
  let callTool: Parameters<typeof createHost>[0]["callTool"];
  const capture = spyOn(Machines, "createMachineHost").mockImplementation((options: Parameters<typeof createHost>[0]) => {
    callTool = options.callTool;
    return createHost(options);
  });
  const failure = new Machines.ForeignFailure({ operation: "code.tool", cause: "lost cell" });
  const failCell = spyOn(Codemode, "composeCodemode").mockImplementation((host: Machines.MachineHost) =>
    compose(host).pipe(Effect.map((mode: Codemode.ComposedCodemode) => ({
      ...mode, callTool: (_call: Machine.ToolCall) => Effect.fail(failure),
    }))),
  );
  try {
    const app = await startOpenOmni({ config: {
      dbPath: ":memory:", host: "127.0.0.1", wsPort: 0,
      model: { provider: "fake", id: "fixture", apiKey: "fixture" },
      machines: { socketPath: socketPath(), enrolled: [] },
    } });
    try {
      if (callTool === undefined) throw new Error("machine callback was not installed");
      expect(await runEffect(Effect.flip(callTool({ cellId: "cell", name: "read", arguments: {} })))).toMatchObject({
        _tag: "ForeignFailure", operation: "codemode.callTool", cause: String(failure),
      });
      expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
    } finally {
      await app.stop();
    }
  } finally {
    capture.mockRestore();
    failCell.mockRestore();
  }
});
