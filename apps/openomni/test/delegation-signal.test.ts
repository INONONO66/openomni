import { expect, test } from "bun:test";
import { DelegationStore } from "@openomni/ledger";
import { createDelegationKernel, type DriverOutcome } from "../src/delegation/kernel";
import { RESIDENT, useDelegationStore } from "./helpers/delegation";

useDelegationStore();

function recoveredKernel() {
  DelegationStore.create({
    delegationId: "recovered",
    operation: "ask",
    address: { kind: "core", scope: "independent" },
    transport: "process",
    deadline: 10000,
    rootDelegationId: "recovered",
    origin: RESIDENT,
    instruction: "work",
    status: "open",
    createdAt: 1,
  });
  return createDelegationKernel({
    drivers: {},
    now: () => 1000,
    newDelegationId: () => "unused",
    wake: () => undefined,
    bootSweep: false,
  });
}

test("recovery observes cancellation on the admitted transport's exact signal after its durable CAS", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const completed = Promise.withResolvers<DriverOutcome>();
  const kernel = createDelegationKernel({
    drivers: {
      process: {
        run(_admitted, _handle, signal) {
          entered.resolve(signal);
          return completed.promise;
        },
      },
    },
    now: () => 1000,
    newDelegationId: () => "live",
    wake: () => undefined,
    bootSweep: false,
  });
  try {
    await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "work" },
        deadline: 10000,
      },
      RESIDENT,
    );
    const signal = kernel.signalFor("live");
    expect(signal).toBe(await entered.promise);
    let statusAtAbort: string | undefined;
    signal.addEventListener(
      "abort",
      () => {
        statusAtAbort = DelegationStore.get("live")?.settled?.status;
      },
      { once: true },
    );
    await kernel.cancelDelegation("live");
    expect(signal.aborted).toBe(true);
    expect(statusAtAbort).toBe("cancelled");
    expect(kernel.signalFor("live").aborted).toBe(true);
  } finally {
    completed.resolve({ status: "cancelled", reason: "cleanup" });
    kernel.stop();
  }
});

test("an open recovered record without a local driver gets the same cancellation signal", async () => {
  const kernel = recoveredKernel();
  try {
    const signal = kernel.signalFor("recovered");
    expect(signal.aborted).toBe(false);
    expect(kernel.signalFor("recovered")).toBe(signal);
    await kernel.cancelDelegation("recovered");
    expect(signal.aborted).toBe(true);
    expect(kernel.signalFor("recovered").aborted).toBe(true);
    expect(() => kernel.signalFor("missing")).toThrow();
  } finally {
    kernel.stop();
  }
});

test("host stop aborts recovery without settling its durable record", () => {
  const kernel = recoveredKernel();
  const signal = kernel.signalFor("recovered");
  kernel.stop();
  expect(signal.aborted).toBe(true);
  expect(kernel.signalFor("recovered").aborted).toBe(true);
  expect(DelegationStore.get("recovered")?.status).toBe("open");
});
