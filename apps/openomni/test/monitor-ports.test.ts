import { expect, test } from "bun:test";
import type { SessionEntityTimerContext } from "@openomni/agent";
import { CommitRefused } from "@openomni/ledger";
import type { LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import {
  createAppLedger,
  type AppLedgerPlane,
  type SessionKernel,
} from "../src/composition/cluster-runtime";
import {
  createWatchMonitorPorts,
  watchState,
  watchTimeoutHook,
  type WatchSpec,
} from "../src/composition/monitor-ports";
import type { WatchSources } from "../src/composition/watch-sources";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { runEffect } from "./helpers/effect";
import { adoptTestFence } from "./helpers/ledger";

const OWNER = "monitor-ports-owner";
const SESSION = "monitor-ports-session";

const watchSpec: WatchSpec = {
  watch: { command: "true", description: "coverage", persistent: true },
  policyGeneration: 1,
  notificationLimit: 300,
};

interface Fixture {
  readonly plane: AppLedgerPlane;
  readonly kernel: SessionKernel;
  readonly fence: number;
  readonly sources: WatchSources;
  readonly installed: string[];
  readonly closed: string[];
}

async function fixture(): Promise<Fixture> {
  const plane = createAppLedger({});
  seedKernelPolicyRows(plane.catalog.policies);
  const kernel = plane.openKernel(SESSION);
  await runEffect(
    kernel.materialize({
      id: SESSION,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: "configure",
      at: 1,
    }),
  );
  const fence = await runEffect(adoptTestFence(kernel, SESSION, OWNER));
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
  return { plane, kernel, fence, sources, installed, closed };
}

function portsFor(input: {
  readonly plane: AppLedgerPlane;
  readonly sources: WatchSources;
  readonly openKernel?: (sessionId: string) => SessionKernel;
}) {
  return createWatchMonitorPorts({
    openKernel: input.openKernel ?? input.plane.openKernel,
    sources: input.sources,
    clock: () => 1000,
    entropy: () => "entropy",
    run: (effect) => runEffect(effect),
  });
}

test("watch arm retries one lost revision race before installing the source", async () => {
  const state = await fixture();
  let commits = 0;
  const racedKernel = new Proxy(state.kernel, {
    get(target, property, receiver) {
      if (property !== "commit") return Reflect.get(target, property, receiver);
      const commit: SessionKernel["commit"] = (input) => {
        commits += 1;
        if (commits === 1) {
          const row = target.row(input.sessionId);
          return Effect.fail(
            new CommitRefused({
              sessionId: input.sessionId,
              reason: "revision",
              expectedRevision: input.expectedRevision,
              currentRevision: row.revision + 1,
              fence: input.fence,
              currentFence: row.leaseFence,
            }),
          );
        }
        return target.commit(input);
      };
      return commit;
    },
  });
  const ports = portsFor({
    plane: state.plane,
    sources: state.sources,
    openKernel: () => racedKernel,
  });
  try {
    const armed = await ports.arm(
      {
        id: "retry",
        sessionId: SESSION,
        kind: "watch",
        fireAt: 1000,
        spec: { encodingVersion: 1, value: watchSpec },
      },
      new AbortController().signal,
    );
    expect(armed).toMatchObject({ id: "retry", status: "armed", epoch: 1 });
    expect(commits).toBe(2);
    expect(state.installed).toEqual(["retry"]);
  } finally {
    state.plane.close();
  }
});

test("watch state scans a full occurrence page before reading the next page", async () => {
  const state = await fixture();
  const ports = portsFor(state);
  try {
    await ports.arm(
      {
        id: "paged",
        sessionId: SESSION,
        kind: "watch",
        fireAt: 1000,
        spec: { encodingVersion: 1, value: watchSpec },
      },
      new AbortController().signal,
    );
    const row = state.kernel.row(SESSION);
    const actions = Array.from(
      { length: 256 },
      (_, index): LedgerAction.Append => ({
        id: `paged:occ:1:${index}`,
        parentId: "paged:arm:1",
        sessionId: SESSION,
        kind: "alarm.fired",
        intent: {
          encodingVersion: 1,
          value: { op: "fired", watchId: "paged", epoch: 1 },
        },
        effect: {
          encodingVersion: 1,
          value: { status: "fired", content: `batch-${index}`, terminal: false },
        },
        irreversible: true,
        ts: 2000 + index,
      }),
    );
    await runEffect(
      state.kernel.commit({
        sessionId: SESSION,
        owner: OWNER,
        fence: state.fence,
        now: 3000,
        expectedRevision: row.revision,
        actions,
        state: row.state,
      }),
    );
    expect(watchState(state.kernel, SESSION, "paged")?.state).toMatchObject({
      status: "armed",
      notifications: 256,
      lastBatch: "batch-255",
    });
  } finally {
    state.plane.close();
  }
});

test("watch timeout commits a terminal occurrence and wake prompt", async () => {
  const state = await fixture();
  const ports = portsFor(state);
  try {
    await ports.arm(
      {
        id: "timed",
        sessionId: SESSION,
        kind: "watch",
        fireAt: 1000,
        spec: { encodingVersion: 1, value: watchSpec },
      },
      new AbortController().signal,
    );
    const context: SessionEntityTimerContext = {
      kernel: state.kernel,
      authority: { sessionId: SESSION, owner: OWNER, fence: state.fence },
      now: 1500,
    };
    const result = await runEffect(
      watchTimeoutHook({ closeSource: (id) => state.closed.push(id) })(context, {
        watchId: "timed",
        epoch: 1,
        fireAt: 1000,
      }),
    );
    expect(result).toBe("applied");
    expect(watchState(state.kernel, SESSION, "timed")?.state).toMatchObject({
      status: "fired",
      notifications: 1,
      lastBatch: JSON.stringify({ watchId: "timed", epoch: 1, reason: "timeout" }),
    });
    expect(state.closed).toEqual(["timed"]);
    expect(state.kernel.pendingMessages(SESSION).map((message) => message.id)).toEqual([
      "timed:timeout:1:prompt",
    ]);
  } finally {
    state.plane.close();
  }
});
