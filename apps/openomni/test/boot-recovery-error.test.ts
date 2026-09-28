import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { createAppLedger } from "../src/composition/cluster-runtime";
import { AppLifecycleFailure } from "../src/runtime";
import { appFixture } from "./helpers/app-fixture";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { approvalRequest } from "./helpers/approval-request";
import { bounded } from "./helpers/protected-dispatch";
import { runEffect } from "./helpers/effect";

test("a pending Owner request keeps the server available while failed recovery is reported", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recovery-failure-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const reported = Promise.withResolvers<Error>();
  const log = spyOn(console, "error").mockImplementation((_message: string, error: Error) =>
    reported.resolve(error),
  );
  let app: Awaited<ReturnType<typeof appFixture>> | undefined;
  try {
    const seed = createAppLedger({ catalogPath, sessionsDir });
    seedKernelPolicyRows(seed.catalog.policies);
    const kernel = seed.openKernel("session");
    await Effect.runPromise(
      kernel.materialize({
        id: "session",
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: kernel.currentPolicyGeneration(),
        actionId: "configure",
        at: 1,
      }),
    );
    const actions = seed.sessionStore("session").actions;
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
    seed.close();
    app = await appFixture({
      sessionRuntime: { clock: () => 100 },
      config: {
        catalogPath,
        sessionsDir,
        host: "127.0.0.1",
        wsPort: 0,
        model: { provider: "fake", id: "fixture", apiKey: "fixture" },
      },
    });
    const failure = await bounded(reported.promise);
    expect(failure).toBeInstanceOf(Error);
    expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
    // v4: disposeEffect closes the runtime's own fiberScope, so running it
    // through the runtime interrupts its host fiber. Run it at the test boundary.
    const shutdown = await runEffect(Effect.exit(app.runtime.disposeEffect));
    await app.runtime.dispose();
    app = undefined;
    expect(Exit.isFailure(shutdown)).toBe(true);
    if (Exit.isFailure(shutdown)) {
      expect(shutdown.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
        [
          Option.none(),
          Option.some(
            new AppLifecycleFailure({ operation: "sessions.recovery", cause: String(failure) }),
          ),
        ],
      ]);
    }
  } finally {
    log.mockRestore();
    if (app !== undefined) await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
