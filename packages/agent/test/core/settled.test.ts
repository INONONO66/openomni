import { describe, expect, it } from "bun:test";
import { settled } from "../../src/core/settled";

describe("settled", () => {
  it("resolves to void once a fulfilled promise settles", async () => {
    await expect(settled(Promise.resolve("value"))).resolves.toBeUndefined();
  });

  it("resolves to void once a rejected promise settles instead of propagating", async () => {
    await expect(settled(Promise.reject(new Error("boom")))).resolves.toBeUndefined();
  });

  it("does not settle before the tracked promise does", async () => {
    const gate = Promise.withResolvers<number>();
    let done = false;
    const tracked = settled(gate.promise).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    gate.resolve(1);
    await tracked;
    expect(done).toBe(true);
  });
});
