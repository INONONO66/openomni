import { createAppLedger, type AppLedgerPlane, type SessionKernel } from "../../src/composition/cluster-runtime";
import type { WatchSources } from "../../src/composition/watch-sources";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { runEffect } from "./effect";
import { adoptTestFence } from "./ledger";
import { testClock } from "./test-entropy";

interface WatchFixture {
  readonly plane: AppLedgerPlane;
  readonly kernel: SessionKernel;
  readonly fence: number;
  readonly sources: WatchSources;
  readonly installed: string[];
  readonly closed: string[];
}

/** One real session and observable fake source lifecycle for monitor tests. */
export async function watchFixture(sessionId: string, owner: string): Promise<WatchFixture> {
  const plane = createAppLedger({ now: testClock() });
  const installed: string[] = [];
  const closed: string[] = [];
  const sources: WatchSources = {
    install: (spec) => {
      installed.push(spec.id);
      return Promise.resolve();
    },
    observe: () => undefined,
    close: (id) => {
      closed.push(id);
      return Promise.resolve();
    },
    closeAll: () => Promise.resolve(),
  };
  seedKernelPolicyRows(plane.catalog.policies);
  const kernel = plane.openKernel(sessionId);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: "configure",
      at: 1,
    }),
  );
  const fence = await runEffect(adoptTestFence(kernel, sessionId, owner));
  return { plane, kernel, fence, sources, installed, closed };
}
