import { describe, expect, test } from "bun:test";
import {
  FileSourceRefusal,
  preflightFileSource,
  recoverFileSource,
  startFileSource,
  type FileSourceDeps,
  type FileStat,
  type FileSystemPort,
} from "../../src/trigger/sources/file";
import type { EventSourceSink } from "../../src/trigger/sources/command";

interface FakeTarget {
  stat: FileStat;
  content: string;
  realpath: string;
}

function missing(): NodeJS.ErrnoException {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function fileRig(initial?: Partial<FakeTarget>) {
  const path = "/work/watch.txt";
  let parentRealpath = "/work";
  let target: FakeTarget | undefined =
    initial === undefined
      ? undefined
      : {
          stat: {
            dev: 1,
            ino: 2,
            size: initial.content?.length ?? 3,
            mtimeMs: 10,
            regular: true,
            symlink: false,
            ...initial.stat,
          },
          content: initial.content ?? "one",
          realpath: initial.realpath ?? path,
        };
  let watchChange: ((filename: string | null) => void) | undefined;
  let watchError: ((error: unknown) => void) | undefined;
  let watchClosed = false;
  let pollCallback: (() => void) | undefined;
  let pollCancelled = false;
  let postReadMutation: (() => void) | undefined;
  let checks = 0;

  const fs: FileSystemPort = {
    realpath(value) {
      if (value === "/work") return parentRealpath;
      if (value === path && target !== undefined) return target.realpath;
      throw missing();
    },
    lstat(value) {
      checks += 1;
      if (value !== path || target === undefined) throw missing();
      return { ...target.stat, size: target.content.length };
    },
    openNoFollow(value) {
      if (value !== path || target === undefined) throw missing();
      return { stat: { ...target.stat, size: target.content.length }, content: target.content };
    },
    fstat(handle) {
      const opened = handle as { stat: FileStat; content: string };
      return { ...opened.stat, size: opened.content.length };
    },
    read(handle, offset, length) {
      const opened = handle as { content: string };
      const bytes = Buffer.from(opened.content).subarray(offset, offset + length);
      postReadMutation?.();
      postReadMutation = undefined;
      return bytes;
    },
    close() {
      // The fake holds no descriptor, so closing is genuinely nothing to do.
    },
    watch(_parent, onChange, onError) {
      watchChange = onChange;
      watchError = onError;
      return {
        close() {
          watchClosed = true;
        },
      };
    },
  };

  const deps: FileSourceDeps = {
    clock: { now: () => 8_000 },
    cwd: "/work",
    fs,
    poll: {
      arm(_delay, callback) {
        pollCallback = callback;
        pollCancelled = false;
        return () => {
          pollCancelled = true;
        };
      },
    },
  };

  return {
    path,
    fs,
    deps,
    get target() {
      return target;
    },
    setTarget(next: FakeTarget | undefined) {
      target = next;
    },
    mutateTarget(changes: { content?: string; ino?: number; mtimeMs?: number; symlink?: boolean }) {
      if (target === undefined) throw new Error("target is absent");
      target = {
        ...target,
        content: changes.content ?? target.content,
        stat: {
          ...target.stat,
          ...(changes.ino === undefined ? {} : { ino: changes.ino }),
          ...(changes.mtimeMs === undefined ? {} : { mtimeMs: changes.mtimeMs }),
          ...(changes.symlink === undefined ? {} : { symlink: changes.symlink }),
        },
      };
    },
    setParentRealpath(value: string) {
      parentRealpath = value;
    },
    mutateAfterRead(operation: () => void) {
      postReadMutation = operation;
    },
    change(filename: string | null = "watch.txt") {
      watchChange?.(filename);
    },
    failWatch(error: unknown) {
      watchError?.(error);
    },
    poll() {
      pollCallback?.();
    },
    get watchClosed() {
      return watchClosed;
    },
    get pollCancelled() {
      return pollCancelled;
    },
    get checks() {
      return checks;
    },
  };
}

function sinkRig() {
  const lines: string[] = [];
  const terminals: Parameters<EventSourceSink["terminal"]>[0][] = [];
  let resolve!: () => void;
  const terminal = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const sink: EventSourceSink = {
    line(text) {
      lines.push(text);
    },
    terminal(input) {
      terminals.push(input);
      resolve();
    },
  };
  return { sink, lines, terminals, terminal };
}

const CREATE = { kind: "event.file", path: "watch.txt", on: "create" } as const;
const MODIFY = { kind: "event.file", path: "watch.txt", on: "modify" } as const;

describe("file Trigger source", () => {
  test("preflight refuses an existing on:create target and a symlink", () => {
    const existing = fileRig({ content: "one" });
    expect(() => preflightFileSource(CREATE, existing.deps)).toThrow(FileSourceRefusal);

    const symlink = fileRig({ stat: { symlink: true } as FileStat });
    expect(() => preflightFileSource(MODIFY, symlink.deps)).toThrow("must not be a symlink");
  });

  test("accepts absence, then atomically hands off create plus completion", async () => {
    const rig = fileRig();
    const prepared = preflightFileSource(CREATE, rig.deps);
    const sink = sinkRig();
    const handle = await startFileSource(prepared, sink.sink, rig.deps);

    rig.setTarget({
      stat: { dev: 1, ino: 4, size: 3, mtimeMs: 20, regular: true, symlink: false },
      content: "new",
      realpath: rig.path,
    });
    await handle.check();
    await sink.terminal;

    expect(sink.terminals).toEqual([
      {
        reason: "completed",
        line: 'create "/work/watch.txt"',
        summary: "watcher completed",
        at: 8_000,
      },
    ]);
    expect(rig.watchClosed).toBe(true);
    expect(rig.pollCancelled).toBe(true);
  });

  test("recovery accepts a safe present on:create target before installing a watcher", async () => {
    const rig = fileRig({ content: "arrived" });
    const prepared = recoverFileSource(CREATE, rig.deps);
    const sink = sinkRig();

    await startFileSource(prepared, sink.sink, rig.deps);
    await sink.terminal;

    expect(sink.terminals[0]).toMatchObject({
      reason: "completed",
      line: 'create "/work/watch.txt"',
    });
    expect(rig.watchClosed).toBe(false);
  });

  test("fires modify only for a changed snapshot with the pinned inode", async () => {
    const rig = fileRig({ content: "one" });
    const prepared = preflightFileSource(MODIFY, rig.deps);
    const sink = sinkRig();
    const handle = await startFileSource(prepared, sink.sink, rig.deps);

    await handle.check();
    expect(sink.terminals).toEqual([]);
    rig.mutateTarget({ content: "two", mtimeMs: 11 });
    await handle.check();
    await sink.terminal;

    expect(sink.terminals[0]).toMatchObject({
      reason: "completed",
      line: 'modify "/work/watch.txt"',
    });
  });

  test("replacement, parent drift, and a post-read race end source_error", async () => {
    const cases: Array<(rig: ReturnType<typeof fileRig>) => void> = [
      (rig) => rig.mutateTarget({ ino: 99 }),
      (rig) => rig.setParentRealpath("/replacement"),
      (rig) => rig.mutateAfterRead(() => rig.mutateTarget({ ino: 100 })),
    ];

    for (const mutate of cases) {
      const rig = fileRig({ content: "one" });
      const prepared = preflightFileSource(MODIFY, rig.deps);
      const sink = sinkRig();
      const handle = await startFileSource(prepared, sink.sink, rig.deps);
      mutate(rig);
      await handle.check();
      await sink.terminal;
      expect(sink.terminals[0]).toMatchObject({
        reason: "source_error",
        detail: "source_identity",
      });
    }
  });

  test("watch callbacks are basename-filtered and the safety poll uses the same check", async () => {
    const rig = fileRig({ content: "one" });
    const prepared = preflightFileSource(MODIFY, rig.deps);
    const sink = sinkRig();
    await startFileSource(prepared, sink.sink, rig.deps);
    const before = rig.checks;

    rig.change("other.txt");
    await Promise.resolve();
    expect(rig.checks).toBe(before);

    rig.mutateTarget({ content: "two", mtimeMs: 12 });
    rig.poll();
    await sink.terminal;
    expect(sink.terminals[0]?.reason).toBe("completed");
  });

  test("cancellation persists its terminal summary before closing handles", async () => {
    const rig = fileRig({ content: "one" });
    const prepared = preflightFileSource(MODIFY, rig.deps);
    const order: string[] = [];
    const handle = await startFileSource(prepared, {
      line: () => undefined,
      terminal() {
        order.push("terminal");
        expect(rig.watchClosed).toBe(false);
      },
    }, rig.deps);

    await handle.cancel("cancelled");
    order.push(rig.watchClosed ? "closed" : "open");
    expect(order).toEqual(["terminal", "closed"]);
  });
});
