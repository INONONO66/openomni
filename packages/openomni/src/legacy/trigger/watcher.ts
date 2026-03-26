import { watch, FSWatcher } from "fs";
import { join } from "path";

export interface WatcherConfig {
  debounceMs: number;
  recursive: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  /** Keep the process alive while watching. Defaults to true. Set false in tests. */
  persistent?: boolean;
}

export interface Watcher {
  watch(path: string): void;
  unwatch(path: string): void;
  isWatching(path: string): boolean;
  getWatchedPaths(): string[];
  clearAll(): void;
}

export type FileEvent = {
  path: string;
  event: "created" | "modified" | "deleted";
  timestamp: number;
};

class FilesystemWatcher implements Watcher {
  private watchers: Map<string, FSWatcher>;
  private config: WatcherConfig;
  private debounceTimers: Map<string, NodeJS.Timeout>;
  private onEvent: (event: FileEvent) => void;

  constructor(config: WatcherConfig, onEvent: (event: FileEvent) => void) {
    this.watchers = new Map();
    this.debounceTimers = new Map();
    this.config = config;
    this.onEvent = onEvent;
  }

  watch(path: string): void {
    if (this.watchers.has(path)) {
      return;
    }

    const watcher = watch(
      path,
      {
        recursive: this.config.recursive,
        persistent: this.config.persistent ?? true,
      },
      (eventType, filename) => {
        const resolvedPath = filename ? join(path, filename.toString()) : path;
        this.handleEvent(resolvedPath, eventType);
      },
    );

    this.watchers.set(path, watcher);
  }

  unwatch(path: string): void {
    const watcher = this.watchers.get(path);
    if (!watcher) {
      return;
    }

    watcher.close();
    this.watchers.delete(path);

    const timer = this.debounceTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
  }

  isWatching(path: string): boolean {
    return this.watchers.has(path);
  }

  getWatchedPaths(): string[] {
    return Array.from(this.watchers.keys());
  }

  clearAll(): void {
    for (const watchedPath of this.getWatchedPaths()) {
      this.unwatch(watchedPath);
    }
  }

  private handleEvent(path: string, eventType: "change" | "rename"): void {
    if (!this.matchesPatterns(path)) {
      return;
    }

    const existingTimer = this.debounceTimers.get(path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);

      const event: FileEvent = {
        path,
        event: eventType === "change" ? "modified" : "created",
        timestamp: Date.now(),
      };

      this.onEvent(event);
    }, this.config.debounceMs);

    timer.unref();
    this.debounceTimers.set(path, timer);
  }

  private matchesPatterns(path: string): boolean {
    const { includePatterns, excludePatterns } = this.config;
    const matchesInclude =
      includePatterns.length === 0 || includePatterns.some((pattern) => path.includes(pattern));
    const matchesExclude = excludePatterns.some((pattern) => path.includes(pattern));

    return matchesInclude && !matchesExclude;
  }
}

export { FilesystemWatcher };
