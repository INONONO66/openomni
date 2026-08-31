/**
 * Composition substrate — reversible effect ownership for the sole app's
 * boot and shutdown.
 *
 * The gap this closes (implementation-status: dynamic composition) has three
 * clauses; this module owns the first — *reversible registration ownership*.
 * Everything boot builds that must later be torn down (the bus journal, the
 * delegation kernel's timers, the machine host, the ws server, channel
 * surfaces) is acquired inside a fiber and released by that fiber, in exact
 * reverse order. Before this, both the boot-rollback path and the stop path
 * restated the teardown sequence by hand, so a new stage could leak by
 * forgetting one line in two places.
 *
 * Two boundaries are deliberate and load-bearing:
 *
 * - Durable facts are not effects. Actor registration, ledger writes, and
 *   journal rows are history; disposing a fiber releases runtime handles
 *   (listeners, timers, sockets, observers) and never reaches back to erase
 *   what was recorded.
 * - There is no silent default. A fiber either mounted and owns its effects,
 *   or it failed and its effects already ran. Nothing here fabricates a
 *   half-present stage.
 *
 * Reactive dependency activation and generation draining land with their
 * first consumers (channel surfaces, delegation drivers) — this module grows
 * when a second consumer exists, not before.
 */

/** Where a fiber is in its life. `pending` arrives with reactive injection. */
type FiberState = "mounting" | "active" | "failed" | "disposed";

interface FiberSnapshot {
  readonly id: string;
  readonly state: FiberState;
  /** How many disposers this fiber owns right now. */
  readonly effects: number;
}

/** Teardown for one acquired thing. Runs at most once, in reverse order. */
type Disposer = () => void | Promise<void>;

interface EffectContext {
  /**
   * Claims ownership of one acquired thing: the disposer runs when this
   * fiber is disposed — on shutdown, on boot rollback, or when a later stage
   * of a failed mount unwinds this one. Registering after `apply` has
   * returned throws: an effect nobody owns is a leak by definition.
   */
  effect(disposer: Disposer): void;
}

interface Composer {
  /**
   * Runs one stage. If `apply` throws, the disposers it already registered
   * run in reverse before the error propagates — a failed stage leaves
   * nothing half-acquired behind.
   */
  mount(id: string, apply: (ctx: EffectContext) => void | Promise<void>): Promise<void>;
  /**
   * Tears every fiber down in reverse mount order. Every disposer runs even
   * when an earlier one throws; the failures are reported together after the
   * last one, never by abandoning the rest. Concurrent and repeated calls
   * share the one release pass — a disposer can never run twice.
   */
  dispose(): Promise<void>;
  /** What is mounted, in mount order — the inspection seam for tests and diagnostics. */
  snapshot(): readonly FiberSnapshot[];
}

interface Fiber {
  readonly id: string;
  state: FiberState;
  readonly disposers: Disposer[];
}

/** Runs one fiber's disposers newest-first; returns the failures, never throws. */
async function release(fiber: Fiber): Promise<readonly Error[]> {
  const failures: Error[] = [];
  for (const disposer of [...fiber.disposers].reverse()) {
    try {
      await disposer();
    } catch (error) {
      // Disposers throw Errors; anything else is normalized at this boundary
      // so the aggregate stays a plain Error list.
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  fiber.disposers.length = 0;
  return failures;
}

export function createComposer(): Composer {
  const fibers: Fiber[] = [];
  let disposed = false;
  let disposal: Promise<void> | undefined;

  return {
    async mount(id, apply) {
      if (disposed) {
        throw new Error(`composition is disposed; cannot mount ${id}`);
      }
      const fiber: Fiber = { id, state: "mounting", disposers: [] };
      fibers.push(fiber);
      let accepting = true;
      const ctx: EffectContext = {
        effect(disposer) {
          if (!accepting) {
            throw new Error(
              `effect registered after ${id} finished mounting — it would be owned by nobody`,
            );
          }
          fiber.disposers.push(disposer);
        },
      };
      try {
        await apply(ctx);
        accepting = false;
        fiber.state = "active";
      } catch (error) {
        accepting = false;
        fiber.state = "failed";
        const rollbackFailures = await release(fiber);
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            `composition stage ${id} failed and its rollback failed`,
          );
        }
        throw error;
      }
    },

    dispose() {
      // One release pass, shared by every caller: a second stop (shutdown
      // handler racing an explicit stop) must observe the same teardown, not
      // run the disposers again.
      disposal ??= (async () => {
        disposed = true;
        const failures: Error[] = [];
        for (const fiber of [...fibers].reverse()) {
          // A failed fiber already ran its rollback; its effects are gone.
          if (fiber.state !== "active") {
            fiber.state = "disposed";
            continue;
          }
          failures.push(...(await release(fiber)));
          fiber.state = "disposed";
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "composition dispose failed");
        }
      })();
      return disposal;
    },

    snapshot() {
      return fibers.map((fiber) => ({
        id: fiber.id,
        state: fiber.state,
        effects: fiber.disposers.length,
      }));
    },
  };
}
