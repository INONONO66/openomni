import { describe, expect, spyOn, test } from "bun:test";
import { listenForAbort } from "../src/index.js";

describe("listenForAbort", () => {
  test("a live signal registers one once-only listener that fires exactly once", () => {
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    listenForAbort(controller.signal, listener);
    expect(added).toHaveBeenCalledWith("abort", listener, { once: true });
    expect(fired).toBe(0);
    controller.abort();
    controller.signal.dispatchEvent(new Event("abort"));
    expect(fired).toBe(1);
  });

  test("an already aborted signal fires the listener at once and registers nothing", () => {
    const signal = AbortSignal.abort();
    const added = spyOn(signal, "addEventListener");
    let fired = 0;
    const detach = listenForAbort(signal, () => {
      fired += 1;
    });
    expect(fired).toBe(1);
    expect(added).not.toHaveBeenCalled();
    expect(detach).not.toThrow();
  });

  test("the detach thunk removes the listener before a later abort", () => {
    const controller = new AbortController();
    let fired = 0;
    const detach = listenForAbort(controller.signal, () => {
      fired += 1;
    });
    detach();
    controller.abort();
    expect(fired).toBe(0);
  });
});
