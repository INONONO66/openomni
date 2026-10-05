import { expect, test } from "bun:test";
import { retryableOnce } from "../src";

/**
 * #1256 r2 C-1: the app `stop()` memo. Concurrent callers join ONE in-flight
 * run, a rejection clears the memo so the next call retries, and a success is
 * permanent.
 */

test("a rejected run clears the memo so the next call retries; success is permanent", async () => {
  let attempts = 0;
  const gates: PromiseWithResolvers<void>[] = [];
  const stop = retryableOnce(() => {
    attempts += 1;
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    return gate.promise;
  });

  // Concurrent callers share the single in-flight run.
  const first = stop();
  const joined = stop();
  expect(attempts).toBe(1);
  gates[0]?.reject(new Error("drain refused"));
  await expect(first).rejects.toThrow("drain refused");
  await expect(joined).rejects.toThrow("drain refused");

  // The rejection cleared the memo: the next call runs again...
  const second = stop();
  expect(attempts).toBe(2);
  gates[1]?.resolve();
  await second;

  // ...and the success is permanent: no further runs, same settled promise.
  await stop();
  expect(attempts).toBe(2);
  expect(stop()).toBe(second);
});
