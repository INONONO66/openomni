import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Cause, Effect, Exit } from "effect";
import { gatewayRuntime } from "../src/gateway";
import { AppLifecycleFailure } from "../src/runtime";
import { startOpenOmni } from "../src/index";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { approvalRequest } from "./helpers/approval-request";
import { bounded } from "./helpers/protected-dispatch";

test("a pending Owner request keeps the server available while failed recovery is reported", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recovery-failure-"));
  const dbPath = join(directory, "storage.sqlite");
  const reported = Promise.withResolvers<Error>();
  const log = spyOn(console, "error").mockImplementation((_message: string, error: Error) =>
    reported.resolve(error),
  );
  let app: Awaited<ReturnType<typeof startOpenOmni>> | undefined;
  try {
    const seed = gatewayRuntime({ dbPath });
    await seed.runPromise(Effect.void);
    seedKernelPolicyRows();
    await seed.runPromise(
      SessionHandleStore.materialize({
        id: "session",
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: SessionHandleStore.currentPolicyGeneration(),
        actionId: "configure",
        at: 1,
      }),
    );
    const actions = Storage.get().actions;
    if (actions === undefined) throw new Error("action storage missing");
    expect(
      actions.append(
        {
          id: "request-state",
          sessionId: "session",
          parentId: "configure",
          kind: "request",
          intent: { encodingVersion: 1, value: {} },
          effect: {
            encodingVersion: 1,
            value: { phase: "state", request: approvalRequest({}, {}) },
          },
          irreversible: true,
          ts: 2,
        },
        1,
      ),
    ).toBeDefined();
    expect(
      actions.append(
        {
          id: "corrupt-outbound",
          sessionId: "session",
          parentId: "request-state",
          kind: "outbound",
          intent: { encodingVersion: 1, value: {} },
          effect: { encodingVersion: 1, value: {} },
          irreversible: true,
          ts: 3,
        },
        2,
      ),
    ).toBeDefined();
    await seed.dispose();
    app = await startOpenOmni({
      sessionRuntime: { clock: () => 100 },
      config: {
        dbPath,
        host: "127.0.0.1",
        wsPort: 0,
        model: { provider: "fake", id: "fixture", apiKey: "fixture" },
      },
    });
    const failure = await bounded(reported.promise);
    expect(failure).toBeInstanceOf(Error);
    expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
    const shutdown = await app.runtime.runPromise(Effect.exit(app.runtime.disposeEffect));
    await app.stop();
    app = undefined;
    expect(Exit.isFailure(shutdown)).toBe(true);
    if (Exit.isFailure(shutdown)) {
      expect(Array.from(Cause.defects(shutdown.cause))).toEqual([
        [new AppLifecycleFailure({ operation: "sessions.recovery", cause: String(failure) })],
      ]);
    }
  } finally {
    log.mockRestore();
    if (app !== undefined) await app.stop();
    Storage.reset();
    rmSync(directory, { recursive: true, force: true });
  }
});
