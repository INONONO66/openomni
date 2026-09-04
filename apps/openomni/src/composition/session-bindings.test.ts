import { expect, test } from "bun:test";
import { SessionBindingCache } from "./session-bindings";

test("session binding leases retain active reuse and release the settled entry once", async () => {
  let creates = 0;
  let closes = 0;
  let releases = 0;
  const cache = new SessionBindingCache<{
    readonly marker: number;
    readonly handle: { close(): Promise<void> };
    release(): void;
  }>();
  const create = () => {
    creates += 1;
    return {
      marker: creates,
      handle: {
        close: async () => {
          closes += 1;
        },
      },
      release: () => {
        releases += 1;
      },
    };
  };

  const first = await cache.acquire("session", create);
  const second = await cache.acquire("session", create);
  expect(second.binding).toBe(first.binding);
  expect(creates).toBe(1);

  await first.release();
  expect(closes).toBe(0);
  const third = await cache.acquire("session", create);
  expect(third.binding).toBe(second.binding);
  await second.release();
  expect(closes).toBe(0);
  await third.release();
  await third.release();
  expect({ closes, releases }).toEqual({ closes: 1, releases: 1 });

  const rehydrated = await cache.acquire("session", create);
  expect(rehydrated.binding.marker).toBe(2);
  await rehydrated.release();
});

test("a new binding waits for the prior binding to finish closing", async () => {
  let finishClose: () => void = () => undefined;
  const closeFinished = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let creates = 0;
  const cache = new SessionBindingCache<{
    readonly id: number;
    readonly handle: { close(): Promise<void> };
    release(): void;
  }>();
  const create = () => {
    creates += 1;
    return {
      id: creates,
      handle: { close: () => closeFinished },
      release: () => undefined,
    };
  };
  const first = await cache.acquire("session", create);

  const releasing = first.release();
  const acquiring = cache.acquire("session", create);
  expect(creates).toBe(1);
  finishClose();
  await releasing;

  const next = await acquiring;
  expect(next.binding.id).toBe(2);
  await next.release();
});
