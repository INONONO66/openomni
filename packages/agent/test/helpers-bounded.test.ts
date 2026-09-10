import { describe, expect, it } from "bun:test";
import { bounded, boundedBy } from "./helpers/bounded";

describe("bounded test signals", () => {
  it("returns the signal value when it settles first", async () => {
    await expect(bounded(Promise.resolve("ready"), "ready signal")).resolves.toBe("ready");
  });

  it("fails with the label once the deadline passes a signal that never settles", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(boundedBy(0)(never, "missing signal")).rejects.toThrow(
      "timed out waiting for missing signal",
    );
  });
});
