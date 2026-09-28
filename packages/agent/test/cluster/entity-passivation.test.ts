// Review F3 + R1 as a package test (plan §4): entityMaxIdleTime passivates the
// entity (activation finalizer closes the session file), the next message
// reactivates it (fence rotates, F5), and a DeliverAt scheduled beyond the
// idle window is not stranded — its delivery reactivates the entity.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import {
  runCluster,
  sendDeadline,
  sendPrompt,
  sessionFence,
  sessionFileClosed,
  sessionFileFor,
  waitUntil,
} from "../helpers/cluster-runtime";

const dir = mkdtempSync(join(tmpdir(), "w52-entity-passivation-"));
const sessionsDir = join(dir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");
const options = { sessionsDir, catalogFile, idleMs: 500 };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("F3: idle passivation closes the session file; the next message reactivates and rotates the fence", async () => {
  const sessionId = "s-idle";
  const file = sessionFileFor(sessionsDir, sessionId);
  const [fenceAfterFirst, fenceAfterSecond] = await runCluster(
    options,
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "idle-m1", "activate");
      const first = sessionFence(catalogFile, sessionId);
      // Passivation witness: the activation finalizer closes the store, which
      // truncates the WAL (file-close observation per plan §4; bounded poll).
      yield* Effect.promise(() =>
        waitUntil("session file closed by the passivation finalizer", () =>
          sessionFileClosed(file),
        ),
      );
      // Reactivation: the next message wakes the entity; activation rotates
      // the catalog fence (F5), proving a fresh activation served it.
      yield* sendPrompt(sessionId, "idle-m2", "wake up");
      return [first, sessionFence(catalogFile, sessionId)] as const;
    }),
  );
  expect(fenceAfterFirst).toBeGreaterThanOrEqual(1);
  expect(fenceAfterSecond).toBe((fenceAfterFirst ?? 0) + 1);
}, 60_000);

test("R1: a DeliverAt beyond the idle window survives passivation and reactivates the entity", async () => {
  const sessionId = "s-timer";
  const file = sessionFileFor(sessionsDir, sessionId);
  const residual = await runCluster(
    options,
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "timer-m1", "activate");
      const fenceBefore = sessionFence(catalogFile, sessionId);
      const tSend = Date.now();
      // The entity reaper's resolution floor is 5s (effect/cluster
      // entityReaper), so passivation lands at ~5s regardless of idleMs.
      // Schedule the timer 9s out — beyond the passivation instant — THEN
      // observe passivation before the wake.
      const pending = yield* Effect.forkScoped(
        sendDeadline(sessionId, "timer-request", tSend + 9000),
      );
      yield* Effect.promise(() =>
        waitUntil("session file closed while the timer is in flight", () =>
          sessionFileClosed(file),
        ),
      );
      // The timer's handled event: its reply resolves only after delivery
      // reactivated the entity at/after the not-before instant.
      yield* Fiber.join(pending);
      const fenceAfter = sessionFence(catalogFile, sessionId);
      expect(fenceAfter).toBe((fenceBefore ?? 0) + 1);
      return Date.now() - tSend;
    }),
  );
  expect(residual).toBeGreaterThanOrEqual(9000);
  expect(residual).toBeLessThan(20_000);
}, 60_000);
