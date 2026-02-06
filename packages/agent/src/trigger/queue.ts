import { TriggerSignal } from "../task/types";

/**
 * EventQueue - Bounded queue with drop policies and lane-based concurrency
 * Implements spec section 4.3: EventQueue
 */

// ============================================================
// Types
// ============================================================

export type DropPolicy = "new" | "old" | "summarize";

export interface QueueConfig {
  /** Maximum items per lane before drop policy applies */
  maxDepth: number;
  /** Policy when queue is full: drop new items, drop oldest, or summarize */
  dropPolicy: DropPolicy;
  /** Per-lane concurrency limits (lane key -> max concurrent) */
  laneConcurrency: Record<string, number>;
  /** Warn if item waits longer than this (ms) */
  waitWarnMs?: number;
  /** Default concurrency for lanes not specified in laneConcurrency */
  defaultConcurrency?: number;
}

export interface QueueItem<T = TriggerSignal> {
  id: string;
  laneKey: string;
  data: T;
  enqueuedAt: number;
  /** Summary of dropped items (only set when dropPolicy is "summarize") */
  droppedSummary?: string;
}

export interface QueueMetrics {
  /** Current depth per lane */
  depthByLane: Map<string, number>;
  /** Total items across all lanes */
  totalDepth: number;
  /** Items dropped per lane */
  droppedByLane: Map<string, number>;
  /** Total items dropped */
  totalDropped: number;
  /** Average wait time in ms per lane */
  avgWaitTimeByLane: Map<string, number>;
  /** Items currently being processed per lane */
  activeByLane: Map<string, number>;
}

export interface DequeueResult<T = TriggerSignal> {
  item: QueueItem<T>;
  waitTimeMs: number;
}

type WaitCallback = (
  laneKey: string,
  depth: number,
  waitTimeMs: number,
) => void;
type DrainCallback<T> = (item: QueueItem<T>) => Promise<void>;

// ============================================================
// Lane - Per-source bounded queue
// ============================================================

class Lane<T = TriggerSignal> {
  private readonly items: QueueItem<T>[] = [];
  private readonly config: QueueConfig;
  private readonly laneKey: string;
  private droppedCount = 0;
  private waitTimeSum = 0;
  private processedCount = 0;
  private activeCount = 0;
  private readonly pending: Array<{
    resolve: (item: QueueItem<T>) => void;
    reject: (error: Error) => void;
  }> = [];

  private closed = false;

  constructor(laneKey: string, config: QueueConfig) {
    this.laneKey = laneKey;
    this.config = config;
  }

  get depth(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get avgWaitTime(): number {
    return this.processedCount > 0 ? this.waitTimeSum / this.processedCount : 0;
  }

  get active(): number {
    return this.activeCount;
  }

  get concurrencyLimit(): number {
    return (
      this.config.laneConcurrency[this.laneKey] ??
      this.config.defaultConcurrency ??
      1
    );
  }

  enqueue(item: QueueItem<T>): boolean {
    if (this.closed) {
      return false;
    }

    if (this.pending.length > 0) {
      const consumer = this.pending.shift()!;
      consumer.resolve(item);
      return true;
    }

    if (this.items.length >= this.config.maxDepth) {
      return this.applyDropPolicy(item);
    }

    this.items.push(item);
    return true;
  }

  async dequeue(): Promise<QueueItem<T> | null> {
    if (this.closed && this.items.length === 0) {
      return null;
    }

    if (this.items.length > 0) {
      return this.items.shift()!;
    }

    return new Promise<QueueItem<T> | null>((resolve, reject) => {
      if (this.closed) {
        resolve(null);
        return;
      }
      this.pending.push({
        resolve: (item) => resolve(item),
        reject,
      });
    });
  }

  tryDequeue(): QueueItem<T> | null {
    if (this.items.length === 0) {
      return null;
    }
    return this.items.shift()!;
  }

  recordProcessed(waitTimeMs: number): void {
    this.waitTimeSum += waitTimeMs;
    this.processedCount++;
  }

  incrementActive(): void {
    this.activeCount++;
  }

  decrementActive(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  canProcess(): boolean {
    return this.activeCount < this.concurrencyLimit;
  }

  close(): void {
    this.closed = true;
    for (const consumer of this.pending) {
      consumer.resolve(null as unknown as QueueItem<T>);
    }
    this.pending.length = 0;
  }

  private applyDropPolicy(newItem: QueueItem<T>): boolean {
    switch (this.config.dropPolicy) {
      case "new":
        this.droppedCount++;
        return false;

      case "old":
        this.items.shift();
        this.items.push(newItem);
        this.droppedCount++;
        return true;

      case "summarize": {
        const dropped = this.items.shift();
        if (dropped && this.items.length > 0) {
          const oldest = this.items[0]!;
          const existingSummary = oldest.droppedSummary ?? "";
          const droppedInfo = `[Dropped at ${new Date(dropped.enqueuedAt).toISOString()}]`;
          oldest.droppedSummary = existingSummary
            ? `${existingSummary}\n${droppedInfo}`
            : droppedInfo;
        }
        this.items.push(newItem);
        this.droppedCount++;
        return true;
      }
    }
  }
}

// ============================================================
// EventQueue - Lane-based concurrent queue
// ============================================================

export interface EventQueueInstance<T = TriggerSignal> {
  /**
   * Enqueue an item to a specific lane
   * @returns true if item was accepted, false if dropped
   */
  enqueue(laneKey: string, data: T): boolean;

  /**
   * Dequeue an item from a specific lane
   */
  dequeue(laneKey: string): Promise<DequeueResult<T> | null>;

  /**
   * Try to dequeue without waiting
   */
  tryDequeue(laneKey: string): DequeueResult<T> | null;

  /**
   * Start draining all lanes with the provided handler
   */
  drain(handler: DrainCallback<T>): Promise<void>;

  /**
   * Stop draining and close all lanes
   */
  stop(): void;

  /**
   * Get current queue metrics
   */
  metrics(): QueueMetrics;

  /**
   * Set callback for wait time warnings
   */
  onWait(callback: WaitCallback): void;

  /**
   * Get all lane keys
   */
  lanes(): string[];

  /**
   * Get or create a lane
   */
  lane(key: string): void;
}

export namespace EventQueue {
  /**
   * Create a new EventQueue instance
   */
  export function create<T = TriggerSignal>(
    config: QueueConfig,
  ): EventQueueInstance<T> {
    const lanes = new Map<string, Lane<T>>();
    let waitCallback: WaitCallback | null = null;
    let draining = false;
    let stopped = false;
    let idCounter = 0;

    function getOrCreateLane(laneKey: string): Lane<T> {
      let lane = lanes.get(laneKey);
      if (!lane) {
        lane = new Lane<T>(laneKey, config);
        lanes.set(laneKey, lane);
      }
      return lane;
    }

    function generateId(): string {
      return `evt_${Date.now()}_${++idCounter}`;
    }

    async function drainLane(
      laneKey: string,
      lane: Lane<T>,
      handler: DrainCallback<T>,
    ): Promise<void> {
      while (!stopped) {
        if (!lane.canProcess()) {
          await sleep(10);
          continue;
        }

        const item = lane.tryDequeue();
        if (!item) {
          await sleep(10);
          continue;
        }

        const waitTimeMs = Date.now() - item.enqueuedAt;

        if (config.waitWarnMs && waitTimeMs > config.waitWarnMs) {
          waitCallback?.(laneKey, lane.depth, waitTimeMs);
        }

        lane.incrementActive();

        try {
          await handler(item);
        } catch (error) {
          console.error(
            `[EventQueue] Error processing item ${item.id} in lane ${laneKey}:`,
            error,
          );
        } finally {
          lane.decrementActive();
          lane.recordProcessed(waitTimeMs);
        }
      }
    }

    return {
      enqueue(laneKey: string, data: T): boolean {
        if (stopped) {
          return false;
        }

        const lane = getOrCreateLane(laneKey);
        const item: QueueItem<T> = {
          id: generateId(),
          laneKey,
          data,
          enqueuedAt: Date.now(),
        };

        return lane.enqueue(item);
      },

      async dequeue(laneKey: string): Promise<DequeueResult<T> | null> {
        const lane = getOrCreateLane(laneKey);
        const item = await lane.dequeue();

        if (!item) {
          return null;
        }

        const waitTimeMs = Date.now() - item.enqueuedAt;
        lane.recordProcessed(waitTimeMs);

        if (config.waitWarnMs && waitTimeMs > config.waitWarnMs) {
          waitCallback?.(laneKey, lane.depth, waitTimeMs);
        }

        return { item, waitTimeMs };
      },

      tryDequeue(laneKey: string): DequeueResult<T> | null {
        const lane = lanes.get(laneKey);
        if (!lane) {
          return null;
        }

        const item = lane.tryDequeue();
        if (!item) {
          return null;
        }

        const waitTimeMs = Date.now() - item.enqueuedAt;
        lane.recordProcessed(waitTimeMs);

        if (config.waitWarnMs && waitTimeMs > config.waitWarnMs) {
          waitCallback?.(laneKey, lane.depth, waitTimeMs);
        }

        return { item, waitTimeMs };
      },

      async drain(handler: DrainCallback<T>): Promise<void> {
        if (draining) {
          throw new Error("Queue is already draining");
        }
        draining = true;

        const workers: Promise<void>[] = [];

        const checkInterval = setInterval(() => {
          for (const [laneKey, lane] of lanes) {
            if (!workers.some((w) => w === undefined)) {
              workers.push(drainLane(laneKey, lane, handler));
            }
          }
        }, 100);

        for (const [laneKey, lane] of lanes) {
          workers.push(drainLane(laneKey, lane, handler));
        }

        await new Promise<void>((resolve) => {
          const checkStopped = setInterval(() => {
            if (stopped) {
              clearInterval(checkStopped);
              clearInterval(checkInterval);
              resolve();
            }
          }, 50);
        });

        await Promise.all(workers);
        draining = false;
      },

      stop(): void {
        stopped = true;
        for (const lane of lanes.values()) {
          lane.close();
        }
      },

      metrics(): QueueMetrics {
        const depthByLane = new Map<string, number>();
        const droppedByLane = new Map<string, number>();
        const avgWaitTimeByLane = new Map<string, number>();
        const activeByLane = new Map<string, number>();
        let totalDepth = 0;
        let totalDropped = 0;

        for (const [key, lane] of lanes) {
          depthByLane.set(key, lane.depth);
          droppedByLane.set(key, lane.dropped);
          avgWaitTimeByLane.set(key, lane.avgWaitTime);
          activeByLane.set(key, lane.active);
          totalDepth += lane.depth;
          totalDropped += lane.dropped;
        }

        return {
          depthByLane,
          totalDepth,
          droppedByLane,
          totalDropped,
          avgWaitTimeByLane,
          activeByLane,
        };
      },

      onWait(callback: WaitCallback): void {
        waitCallback = callback;
      },

      lanes(): string[] {
        return [...lanes.keys()];
      },

      lane(key: string): void {
        getOrCreateLane(key);
      },
    };
  }

  /**
   * Default configuration
   */
  export const defaultConfig: QueueConfig = {
    maxDepth: 100,
    dropPolicy: "new",
    laneConcurrency: {},
    waitWarnMs: 5000,
    defaultConcurrency: 1,
  };
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
