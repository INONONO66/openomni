import type { Alarm } from "@openomni/protocol";
import { commandSource, pathSource, type AlarmSource } from "./alarm-sources";

/**
 * Watch plane over the Session entity (W5.2, plan §1 F2): this module only
 * holds the native OS handles (PTY, fs watcher). Every occurrence is sent as a
 * `WatchFired` entity message and every timed watch arms one `WatchTimeout`
 * DeliverAt message; durable dedupe is the chain's committed occurrence id,
 * never cancelled storage.
 */
export interface WatchFire {
  readonly watchId: string;
  readonly epoch: number;
  /** Transport occurrence captured at the source (line slot, path stat identity, exit). */
  readonly sourceKey: string;
  readonly content: string;
  readonly terminal: boolean;
}

export interface WatchTimeoutArm {
  readonly watchId: string;
  readonly epoch: number;
  readonly fireAt: number;
}

/** Entity-message senders, implemented over the Session entity client. */
export interface WatchSenders {
  watchFired(fire: WatchFire): Promise<void>;
  watchTimeout(arm: WatchTimeoutArm): Promise<void>;
}

export interface WatchSourceSpec {
  readonly id: string;
  readonly epoch: number;
  readonly watch: Alarm.Watch;
}

export interface WatchSources {
  install(spec: WatchSourceSpec): Promise<void>;
  /** Reconciles a path watch's stat identity outside its native callback. */
  observe(id: string): void;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface Holder {
  source: AlarmSource;
  /** Per-watch send serialization: occurrences leave in source order. */
  tail: Promise<void>;
}

export function createWatchSources(
  senders: WatchSenders,
  options: {
    readonly clock: () => number;
    readonly failure: (watchId: string, error: Error) => void;
  },
): WatchSources {
  const holders = new Map<string, Holder>();

  function enqueue(holder: Holder, fire: WatchFire): void {
    holder.tail = holder.tail
      .then(() => senders.watchFired(fire))
      .catch((error: Error) => options.failure(fire.watchId, error));
  }

  function summary(
    spec: WatchSourceSpec,
    reason: "exit" | "source_error",
    exitCode: number | null,
  ) {
    return {
      watchId: spec.id,
      epoch: spec.epoch,
      sourceKey: `${reason}:${spec.epoch}`,
      content: JSON.stringify({ watchId: spec.id, epoch: spec.epoch, reason, exitCode }),
      terminal: true,
    } satisfies WatchFire;
  }

  function sourceFailure(spec: WatchSourceSpec, holder: Holder, error: Error): void {
    enqueue(holder, summary(spec, "source_error", null));
    options.failure(spec.id, error);
  }

  function startCommand(
    spec: WatchSourceSpec,
    watch: Extract<Alarm.Watch, { command: string }>,
    holder: Holder,
  ): AlarmSource {
    const filter = watch.filter === undefined ? undefined : new RegExp(watch.filter);
    let lines = 0;
    return commandSource(
      watch.command,
      (content) => {
        lines += 1;
        if (filter === undefined || filter.test(content))
          enqueue(holder, {
            watchId: spec.id,
            epoch: spec.epoch,
            sourceKey: `line:${spec.epoch}:${lines}`,
            content,
            terminal: false,
          });
      },
      (code) => enqueue(holder, summary(spec, "exit", code)),
      (error) => sourceFailure(spec, holder, error),
    );
  }

  function startPath(
    spec: WatchSourceSpec,
    watch: Extract<Alarm.Watch, { path: string }>,
    holder: Holder,
  ): AlarmSource {
    return pathSource(
      watch,
      (content, identity) =>
        enqueue(holder, {
          watchId: spec.id,
          epoch: spec.epoch,
          sourceKey: `path:${identity}`,
          content,
          terminal: false,
        }),
      (error) => sourceFailure(spec, holder, error),
    );
  }

  async function close(id: string): Promise<void> {
    const holder = holders.get(id);
    if (holder === undefined) return;
    holders.delete(id);
    await holder.source.close();
    await holder.tail;
  }

  return {
    async install(spec) {
      // Reinstall replaces the previous epoch's handle before any new occurrence.
      await close(spec.id);
      if (spec.watch.timeout_ms !== undefined)
        await senders.watchTimeout({
          watchId: spec.id,
          epoch: spec.epoch,
          fireAt: options.clock() + spec.watch.timeout_ms,
        });
      const holder: Holder = {
        source: { close: () => Promise.resolve() },
        tail: Promise.resolve(),
      };
      holder.source =
        "command" in spec.watch
          ? startCommand(spec, spec.watch, holder)
          : startPath(spec, spec.watch, holder);
      holders.set(spec.id, holder);
    },
    observe(id) {
      holders.get(id)?.source.observe?.();
    },
    close,
    async closeAll() {
      await Promise.all([...holders.keys()].map(close));
    },
  };
}
