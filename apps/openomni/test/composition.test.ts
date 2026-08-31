import { describe, expect, test } from "bun:test";
import { createComposer, rollbackToCause } from "../src/composition/composer";

const noop = () => undefined;

describe("rollback to cause", () => {
  test("releases the composer and rethrows the original cause by identity", async () => {
    const composer = createComposer();
    let released = false;
    await composer.mount("stage", (ctx) => {
      ctx.effect(() => {
        released = true;
      });
    });
    const cause = new Error("the run broke");

    const thrown = await rollbackToCause(composer, cause).then(
      () => null,
      (error: Error) => error,
    );

    expect(thrown).toBe(cause);
    expect(released).toBe(true);
  });

  test("surfaces both faults when the rollback itself fails", async () => {
    const composer = createComposer();
    const disposeError = new Error("disposer broke");
    await composer.mount("stage", (ctx) => {
      ctx.effect(() => {
        throw disposeError;
      });
    });
    const cause = new Error("the run broke");

    const thrown = await rollbackToCause(composer, cause).then(
      () => null,
      (error: AggregateError) => error,
    );

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown?.message).toBe("composition failed and its rollback failed");
    expect(thrown?.errors[0]).toBe(cause);
    expect(thrown?.errors[1]).toBeInstanceOf(AggregateError);
  });
});

describe("composition substrate", () => {
  test("mounted stages report active with their owned effect counts", async () => {
    const composer = createComposer();
    await composer.mount("a", (ctx) => {
      ctx.effect(noop);
      ctx.effect(noop);
    });
    await composer.mount("b", noop);
    expect(composer.snapshot()).toEqual([
      { id: "a", state: "active", effects: 2 },
      { id: "b", state: "active", effects: 0 },
    ]);
  });

  test("dispose releases effects newest-first across and within fibers", async () => {
    const composer = createComposer();
    const order: string[] = [];
    await composer.mount("first", (ctx) => {
      ctx.effect(() => {
        order.push("first.1");
      });
      ctx.effect(() => {
        order.push("first.2");
      });
    });
    await composer.mount("second", (ctx) => {
      ctx.effect(() => {
        order.push("second.1");
      });
    });
    await composer.dispose();
    expect(order).toEqual(["second.1", "first.2", "first.1"]);
    expect(composer.snapshot().map((fiber) => fiber.state)).toEqual(["disposed", "disposed"]);
  });

  test("a failed mount releases its own effects and rethrows the cause", async () => {
    const composer = createComposer();
    const order: string[] = [];
    await composer.mount("ok", (ctx) => {
      ctx.effect(() => {
        order.push("ok.release");
      });
    });
    const boom = new Error("stage exploded");
    await expect(
      composer.mount("bad", (ctx) => {
        ctx.effect(() => {
        order.push("bad.release");
      });
        throw boom;
      }),
    ).rejects.toBe(boom);
    // Only the failed fiber unwound; the earlier fiber still owns its effect.
    expect(order).toEqual(["bad.release"]);
    expect(composer.snapshot()).toEqual([
      { id: "ok", state: "active", effects: 1 },
      { id: "bad", state: "failed", effects: 0 },
    ]);
  });

  test("a failed mount whose rollback also fails reports both causes", async () => {
    const composer = createComposer();
    const mountFailure = new Error("mount failed");
    const releaseFailure = new Error("release failed");
    const rejection = composer.mount("bad", (ctx) => {
      ctx.effect(() => {
        throw releaseFailure;
      });
      throw mountFailure;
    });
    await expect(rejection).rejects.toThrow(
      "composition stage bad failed and its rollback failed",
    );
    const caught = await rejection.then(
      () => null,
      (error: AggregateError) => error,
    );
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught?.errors).toEqual([mountFailure, releaseFailure]);
  });

  test("dispose runs every disposer even when one throws, then reports the failures", async () => {
    const composer = createComposer();
    const order: string[] = [];
    const failure = new Error("release failed");
    await composer.mount("a", (ctx) => {
      ctx.effect(() => {
        order.push("a.release");
      });
    });
    await composer.mount("b", (ctx) => {
      ctx.effect(() => {
        throw failure;
      });
    });
    const rejection = composer.dispose();
    await expect(rejection).rejects.toThrow("composition dispose failed");
    const caught = await rejection.then(
      () => null,
      (error: AggregateError) => error,
    );
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught?.errors).toEqual([failure]);
    // The failing disposer did not abandon the rest.
    expect(order).toEqual(["a.release"]);
  });

  test("a failed fiber's effects do not run again on dispose", async () => {
    const composer = createComposer();
    let releases = 0;
    await expect(
      composer.mount("bad", (ctx) => {
        ctx.effect(() => {
          releases += 1;
        });
        throw new Error("mount failed");
      }),
    ).rejects.toThrow("mount failed");
    await composer.dispose();
    expect(releases).toBe(1);
  });

  test("dispose is idempotent and mounting afterwards throws", async () => {
    const composer = createComposer();
    let releases = 0;
    await composer.mount("a", (ctx) => {
      ctx.effect(() => {
        releases += 1;
      });
    });
    await composer.dispose();
    await composer.dispose();
    expect(releases).toBe(1);
    await expect(composer.mount("late", noop)).rejects.toThrow(
      "composition is disposed; cannot mount late",
    );
  });

  test("concurrent dispose calls share one release pass", async () => {
    const composer = createComposer();
    let releases = 0;
    await composer.mount("a", (ctx) => {
      ctx.effect(async () => {
        await Promise.resolve();
        releases += 1;
      });
    });
    // A shutdown handler racing an explicit stop must not run disposers twice.
    await Promise.all([composer.dispose(), composer.dispose()]);
    expect(releases).toBe(1);
  });

  test("registering an effect after apply returns is an ownership leak and throws", async () => {
    const composer = createComposer();
    let escaped: ((disposer: () => void) => void) | undefined;
    await composer.mount("a", (ctx) => {
      escaped = (disposer) => ctx.effect(disposer);
    });
    expect(escaped).toBeDefined();
    expect(() => escaped?.(noop)).toThrow(
      "effect registered after a finished mounting — it would be owned by nobody",
    );
  });

  test("async disposers are awaited in order", async () => {
    const composer = createComposer();
    const order: string[] = [];
    await composer.mount("a", (ctx) => {
      ctx.effect(async () => {
        await Promise.resolve();
        order.push("a.release");
      });
    });
    await composer.mount("b", (ctx) => {
      ctx.effect(() => {
        order.push("b.release");
      });
    });
    await composer.dispose();
    expect(order).toEqual(["b.release", "a.release"]);
  });
});
