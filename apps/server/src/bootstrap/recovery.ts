import type { Channel } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import type { DefaultDispatchRuntime, EffectReconciler } from "@openomni/openomni";
import { WaitService } from "@openomni/channels";
import { Session, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { newTraceId } from "@openomni/telemetry";
import { recoverInterruptedMessages, type RecoveryItem } from "../recovery";

async function processRetryQueue(
  queue: RecoveryItem[],
  handler: Channel.MessageHandler,
  traceId: string,
): Promise<void> {
  Bus.publish(Operational.Events.Info, {
    traceId,
    time: Date.now(),
    component: "server",
    msg: `recovery processing ${queue.length} retry item(s)`,
  });

  for (const item of queue) {
    try {
      await handler({
        id: item.messageId,
        // D11: retried messages replay under the recovery pass's trace — the
        // original inbound trace did not survive the interruption.
        traceId,
        surfaceKey: item.surfaceKey,
        text: item.text,
        sender: { id: "recovery", name: "recovery" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Bus.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: `recovery retry failed for ${item.messageId}`,
        context: { err: message },
      });
    }
  }

  Bus.publish(Operational.Events.Info, {
    traceId,
    time: Date.now(),
    component: "server",
    msg: "recovery retry processing complete",
  });
}

export type BootstrapRecoveryInput = Readonly<{
  handler: Channel.MessageHandler | undefined;
  coordinator?: {
    recoverInterruptedRuns(traceId: string): Promise<{ recovered: number; sessions: string[] }>;
  };
  traceId?: string;
  completionRuntime: Pick<DefaultDispatchRuntime, "recoverRecordedWorkItemCompletions">;
  /** #492 finish reconciliation — probes every outcome-less effect intent at boot. */
  effects?: Pick<EffectReconciler, "reconcile">;
}>;

type InboundSurface = Readonly<{ start(traceId: string): Promise<void> | void }>;

export async function startInboundSurfacesAfterRecovery<T>(
  input: Readonly<{
    recover(): Promise<void>;
    createServer(): T;
    channels: readonly InboundSurface[];
    /** Boot trace — channel starts are part of the boot's causal chain (D11 group C). */
    traceId: string;
  }>,
): Promise<T> {
  await input.recover();
  const server = input.createServer();
  await Promise.all(input.channels.map((channel) => channel.start(input.traceId)));
  return server;
}

/**
 * Boot ledger tail verification (#510 D1): records every chain-break as an
 * observe-only Operational event PLUS one `Operational.Events.GovernorIncident`
 * (the #510 contract: "a corrupted tail emits a chain-break event plus
 * Governor incident without refusing boot") and RETURNS — a broken tail
 * never refuses boot (full-chain verification is the #226 offline restore
 * drill).
 */
function recordLedgerChainBreaks(traceId: string): void {
  try {
    const ledger = Storage.getAdapter().ledger;
    if (!ledger) {
      // Loud absence (AGENTS.md rule 7): the ledger sub-adapter is optional
      // for test fakes ONLY — a production adapter without it means tail
      // verification cannot run, and that must surface as an Operational
      // error (via the catch below), never as a silent empty result.
      throw new Error(
        "storage adapter does not implement ledger reads — tail verification skipped",
      );
    }
    const breaks = ledger.verifyTail();
    for (const chainBreak of breaks) {
      Bus.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: `ledger chain-break detected at boot: ${chainBreak.streamId} seq ${chainBreak.seq} (${chainBreak.code})`,
        context: { ...chainBreak },
      });
      // The Governor incident (#510 Done-means): a typed, persisted
      // (NORMAL-durability telemetry) record for the Governor role's
      // post-hoc analysis. Observe-only — it never refuses boot and never
      // authorizes anything.
      Bus.publish(Operational.Events.GovernorIncident, {
        traceId,
        time: Date.now(),
        component: "server",
        incident: "chain_break",
        msg: `ledger chain-break at boot: ${chainBreak.streamId} seq ${chainBreak.seq} (${chainBreak.code})`,
        context: { ...chainBreak },
      });
    }
  } catch (error) {
    // Observe-only surface: a verification failure is itself recorded and
    // must not refuse boot any more than a chain-break does.
    Bus.publish(Operational.Events.Error, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "ledger tail verification failed at boot",
      context: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * #492 finish reconciliation at boot: every outcome-less `effect:<id>` intent
 * is probed under its idempotency key BEFORE recorded WorkItem completions
 * resume (admission may be blocked exactly on those unresolved effects).
 * Observe-only like the chain-break walk: a sweep failure is recorded loudly
 * and boot proceeds — the intents stay durable, admission stays blocked, and
 * the next sweep retries. Exhaustion escalation lives in the injected Stakes
 * seam (see bootstrap/effects.ts), never here.
 */
async function reconcileOutstandingEffects(
  effects: Pick<EffectReconciler, "reconcile">,
  traceId: string,
): Promise<void> {
  try {
    const summary = await effects.reconcile(traceId);
    Bus.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: `recovery reconciled ${summary.resolved} of ${summary.scanned} outstanding effect intent(s)`,
      context: { ...summary },
    });
  } catch (error) {
    Bus.publish(Operational.Events.Error, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "effect reconciliation failed at boot",
      context: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

export async function runRecovery(input: BootstrapRecoveryInput): Promise<void> {
  const { handler, coordinator, traceId, completionRuntime: completionRecovery } = input;
  const startTime = Date.now();
  const id = traceId ?? newTraceId();

  Bus.publish(Operational.Events.RecoveryStarted, {
    traceId: id,
    time: startTime,
  });

  let sessionsRecovered = 0;
  try {
    recordLedgerChainBreaks(id);
    if (input.effects) {
      await reconcileOutstandingEffects(input.effects, id);
    }
    const recoveryResult = await coordinator?.recoverInterruptedRuns(id);
    sessionsRecovered = recoveryResult?.sessions.length ?? 0;
    if (completionRecovery) {
      try {
        const receipt = await completionRecovery.recoverRecordedWorkItemCompletions(id);
        // Loud per-failure surfacing (#510 review fix F4): a completion
        // resume that fails (e.g. a staleHead against a 0014-shifted
        // recorded head) names its work item in its own Operational.Events.Error —
        // never buried in an aggregate context blob. Boot stays alive.
        for (const failure of receipt.failures) {
          Bus.publish(Operational.Events.Error, {
            traceId: id,
            time: Date.now(),
            component: "server",
            msg: `recovery failed to resume recorded WorkItem completion: ${failure.workItemHash}`,
            context: {
              workItemHash: failure.workItemHash,
              admissionId: failure.admissionId,
              error: failure.error,
            },
          });
        }
        Bus.publish(Operational.Events.Info, {
          traceId: id,
          time: Date.now(),
          component: "server",
          msg: `recovery resumed ${receipt.recovered} recorded WorkItem completion(s)`,
          context: {
            skipped: receipt.skipped,
            failures: receipt.failures.length,
          },
        });
      } catch (error) {
        Bus.publish(Operational.Events.Error, {
          traceId: id,
          time: Date.now(),
          component: "server",
          msg: "recovery failed to resume recorded WorkItem completions",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    // #548: PendingInteractionStore is frozen — the boot expiry sweep is
    // retired. Read-time expiry (the store's follow-up-window filter on
    // findByCorrelation) gates frozen rows; this receipt records the
    // intentional no-op so recovery stays auditable. Boot-restoration
    // semantics are #217's scope and are untouched here.
    Bus.publish(Operational.Events.Info, {
      traceId: id,
      time: Date.now(),
      component: "server",
      msg: "recovery skipped the pending-interaction expiry sweep: store frozen (#548), read-time expiry gates frozen rows",
    });
    // #707: the wait service lives in the gateway router band; the sweep
    // publishes its per-corrupt-wait errors through the injected sink.
    const expiredWaits = WaitService.sweepExpired(id, Bus.publish);
    if (expiredWaits.length > 0) {
      Bus.publish(Operational.Events.Info, {
        traceId: id,
        time: Date.now(),
        component: "server",
        msg: `recovery expired ${expiredWaits.length} wait(s)`,
      });
    }
    // Session TTL expiry: reads (Session.get/list) only filter expired rows;
    // this sweep is the one deliberate deletion point (same seam as the wait
    // sweep above — boot-time only until a periodic scheduler exists).
    const expiredSessions = Session.sweepExpired(id);
    if (expiredSessions.length > 0) {
      Bus.publish(Operational.Events.Info, {
        traceId: id,
        time: Date.now(),
        component: "server",
        msg: `recovery removed ${expiredSessions.length} expired session(s)`,
      });
    }

    const retryQueue = await recoverInterruptedMessages(id);
    if (handler && retryQueue.length > 0) {
      await processRetryQueue(retryQueue, handler, id);
    } else if (retryQueue.length > 0) {
      Bus.publish(Operational.Events.Warn, {
        traceId: id,
        time: Date.now(),
        component: "server",
        msg: `recovery ${retryQueue.length} message(s) need retry but no handler available`,
      });
    }
  } finally {
    const durationMs = Date.now() - startTime;
    Bus.publish(Operational.Events.RecoveryCompleted, {
      traceId: id,
      sessionsRecovered,
      durationMs,
      time: Date.now(),
    });
  }
}
