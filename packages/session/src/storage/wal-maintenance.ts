import type { Database } from "bun:sqlite";
import { Operational } from "@openomni/protocol";
import { Bus } from "../bus/index.js";

export type WalMaintenanceHandle = { stop: () => void };

export type WalMaintenanceOptions = {
  intervalMs?: number;
  walSizeThresholdMb?: number;
};

export namespace WalMaintenance {
  export function start(db: Database, options?: WalMaintenanceOptions): WalMaintenanceHandle {
    const intervalMs = options?.intervalMs ?? 5 * 60 * 1000;

    const run = () => {
      try {
        const result = db.query("PRAGMA wal_checkpoint(RESTART)").get() as {
          busy: number;
          log: number;
          checkpointed: number;
        } | null;

        if (result && result.busy > 0) {
          Bus.publish(Operational.Warn, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "storage.wal",
            msg: "WAL checkpoint had busy pages",
            context: {
              busy: result.busy,
              log: result.log,
              checkpointed: result.checkpointed,
            },
          });
        }
      } catch (err) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "storage.wal",
          msg: "WAL checkpoint failed",
          context: { error: String(err) },
        });
      }
    };

    const timer = setInterval(run, intervalMs);

    return {
      stop: () => clearInterval(timer),
    };
  }
}
