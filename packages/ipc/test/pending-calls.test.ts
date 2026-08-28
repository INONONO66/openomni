import { describe, expect, test } from "bun:test";
import { IpcConnectionError, IpcTimeoutError } from "../src/errors";
import { PendingCalls } from "../src/pending-calls";

describe("PendingCalls registry", () => {
  test("register + settle resolves with the value and drops the entry", async () => {
    const pending = new PendingCalls();
    const call = pending.register("req-1", 1_000, () => new IpcTimeoutError("request timeout: m"));
    expect(pending.size).toBe(1);
    expect(pending.settle("req-1", { ok: true, value: { answer: 42 } })).toBe(true);
    await expect(call).resolves.toEqual({ answer: 42 });
    expect(pending.size).toBe(0);
  });

  test("settle returns false for an unknown id", () => {
    const pending = new PendingCalls();
    expect(pending.settle("nope", { ok: true, value: 1 })).toBe(false);
  });

  test("settle with an error outcome rejects with that exact error", async () => {
    const pending = new PendingCalls();
    const call = pending.register("req-1", 1_000, () => new IpcTimeoutError("x"));
    const err = new IpcConnectionError("socket closed");
    expect(pending.settle("req-1", { ok: false, error: err })).toBe(true);
    const caught = await call.catch((e: unknown) => e);
    expect(caught).toBe(err);
  });

  test("a where predicate that rejects the metadata leaves the entry pending", async () => {
    const pending = new PendingCalls<string>();
    const call = pending.register("req-1", 1_000, () => new IpcTimeoutError("x"), {
      meta: "conn-1",
    });
    // Wrong connection: no settle, entry survives.
    expect(pending.settle("req-1", { ok: true, value: 1 }, (conn) => conn === "conn-2")).toBe(
      false,
    );
    expect(pending.size).toBe(1);
    // Owning connection: settles.
    expect(pending.settle("req-1", { ok: true, value: 2 }, (conn) => conn === "conn-1")).toBe(
      true,
    );
    await expect(call).resolves.toBe(2);
    expect(pending.size).toBe(0);
  });

  test("timeout rejects with the timeoutError() error and drops the entry", async () => {
    const pending = new PendingCalls();
    const call = pending.register("req-1", 10, () => new IpcTimeoutError("request timeout: slow"));
    await expect(call).rejects.toBeInstanceOf(IpcTimeoutError);
    await expect(call).rejects.toThrow("request timeout: slow");
    expect(pending.size).toBe(0);
    // A late response finds nothing to settle.
    expect(pending.settle("req-1", { ok: true, value: 1 })).toBe(false);
  });

  test("send runs inside the executor: a throwing send rejects the call", async () => {
    const pending = new PendingCalls();
    const call = pending.register("req-1", 1_000, () => new IpcTimeoutError("x"), {
      send: () => {
        throw new IpcConnectionError("write failed");
      },
    });
    await expect(call).rejects.toThrow("write failed");
    pending.failAll(new IpcConnectionError("cleanup"));
  });

  test("failAll rejects every pending call with the given error and clears the registry", async () => {
    const pending = new PendingCalls();
    const first = pending.register("a", 1_000, () => new IpcTimeoutError("x"));
    const second = pending.register("b", 1_000, () => new IpcTimeoutError("x"));
    const err = new IpcConnectionError("client closed");
    pending.failAll(err);
    expect(await first.catch((e: unknown) => e)).toBe(err);
    expect(await second.catch((e: unknown) => e)).toBe(err);
    expect(pending.size).toBe(0);
  });

  test("failAll with a where predicate fails only matching entries", async () => {
    const pending = new PendingCalls<string>();
    const dying = pending.register("a", 1_000, () => new IpcTimeoutError("x"), { meta: "conn-1" });
    const survivor = pending.register("b", 1_000, () => new IpcTimeoutError("x"), {
      meta: "conn-2",
    });
    pending.failAll(new IpcConnectionError("socket closed"), (conn) => conn === "conn-1");
    await expect(dying).rejects.toThrow("socket closed");
    // The other connection's call is untouched and still settles normally.
    expect(pending.size).toBe(1);
    expect(pending.settle("b", { ok: true, value: "survived" })).toBe(true);
    await expect(survivor).resolves.toBe("survived");
    expect(pending.size).toBe(0);
  });
});
