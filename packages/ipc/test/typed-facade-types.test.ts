import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Ipc } from "@openomni/protocol";
import { connectIpcClient, createIpcServer, typedCall } from "../src/index";
import { socketPath } from "./helpers/socket-path";

const fixtureConfig = fileURLToPath(
  new URL("./typed-facade-fixtures/tsconfig.json", import.meta.url),
);

test("typed facade rejects schema-invalid calls while generic calls remain valid", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
      "--noEmit",
      "-p",
      fixtureConfig,
    ],
    {
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  if (result.exitCode !== 0) {
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    throw new Error(`typed facade compile fixture failed:\n${output}`);
  }

  expect(result.exitCode).toBe(0);
}, 15_000);

test("typed facade round-trips a known method through the public transport barrel", async () => {
  const path = socketPath("typed-call");
  const params = { cellId: "typed-cell", code: "21 * 2", timeoutMs: 1_000 };
  const observed: Array<{ method: string; params: unknown }> = [];
  const server = await createIpcServer(path, (method, received, respond) => {
    observed.push({ method, params: received });
    const request = Ipc.Methods["machine.run_cell"].params.parse(received);
    respond(
      Ipc.Methods["machine.run_cell"].result.parse({
        status: "completed",
        cellId: request.cellId,
        output: { stdout: request.code, stderr: "" },
        value: "42",
      }),
    );
  });
  try {
    const client = await connectIpcClient(path);
    try {
      const result = await typedCall(client, "machine.run_cell", params, 1_000);
      expect(observed).toEqual([{ method: "machine.run_cell", params }]);
      expect(result).toEqual({
        status: "completed",
        cellId: "typed-cell",
        output: { stdout: "21 * 2", stderr: "" },
        value: "42",
      });
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});
