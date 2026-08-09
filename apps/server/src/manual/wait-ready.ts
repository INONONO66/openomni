#!/usr/bin/env bun
/**
 * #492 bounded readiness driver (issue deliverable; #217 and #226 consume
 * this and do not recreate it). Watches ONE event source for an exact event
 * line within a bounded window:
 *
 *   --service <unit>   follow `journalctl --user -u <unit>` from a cursor
 *                      pinned BEFORE the announce marker is written
 *   --log <file>       native offset-pinned follower (portable test source)
 *
 * Contract: the `--announce <marker-file>` marker is written only AFTER the
 * read position is pinned (so a caller can order "subscribe, then restart"
 * without a race; an empty journal has no cursor to pin — that one case is
 * reported loudly on stderr); the producer is owned and terminated on exit;
 * exit 0 only when the exact `--event` string is observed; exit 1 on
 * timeout. `--json` prints `{observed, event, elapsedMs}` to stdout.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export type WaitReadyArgs = Readonly<{
  source: Readonly<{ type: "service"; unit: string } | { type: "log"; file: string }>;
  event: string;
  timeoutMs: number;
  json: boolean;
  announce?: string;
}>;

export function parseWaitReadyArgs(argv: string[]): WaitReadyArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: "string" },
      log: { type: "string" },
      event: { type: "string" },
      "timeout-ms": { type: "string" },
      json: { type: "boolean", default: false },
      announce: { type: "string" },
    },
  });
  if ((values.service === undefined) === (values.log === undefined)) {
    throw new Error("exactly one of --service or --log is required");
  }
  if (!values.event) {
    throw new Error("--event is required");
  }
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return {
    source:
      values.service !== undefined
        ? { type: "service", unit: values.service }
        : { type: "log", file: values.log as string },
    event: values.event,
    timeoutMs,
    json: values.json,
    ...(values.announce === undefined ? {} : { announce: values.announce }),
  };
}

export type WaitReadyResult = Readonly<{ observed: boolean; event: string; elapsedMs: number }>;

/**
 * Scans a line source for the exact event within the timeout. `onSubscribed`
 * fires once the line iterator is attached — before any line is read — which
 * is the announce-marker ordering point.
 */
export async function watchForEvent(input: {
  lines: AsyncIterable<string>;
  event: string;
  timeoutMs: number;
  onSubscribed?: () => void;
}): Promise<WaitReadyResult> {
  const started = Date.now();
  const iterator = input.lines[Symbol.asyncIterator]();
  input.onSubscribed?.();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === "timeout" || next.done === true) {
        return { observed: false, event: input.event, elapsedMs: Date.now() - started };
      }
      if (next.value.includes(input.event)) {
        return { observed: true, event: input.event, elapsedMs: Date.now() - started };
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Best-effort close, deliberately NOT awaited: an async generator parked
    // on a pending next() queues return() behind it, so awaiting here would
    // deadlock the timeout path (the producer is owned and killed by the
    // caller, which ends the underlying stream).
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    yield* parts;
  }
  if (buffer !== "") yield buffer;
}

/**
 * Native log follower: only lines appended AFTER `fromOffset` are yielded.
 * The offset is captured by the caller BEFORE the announce marker is written,
 * so "subscribe, then produce" cannot race (a spawned `tail -F -n 0` would —
 * the marker could land before tail has the file open, silently skipping the
 * event). `isStopped` bounds the loop: a quiet file never reaches a yield, so
 * a queued `iterator.return()` alone would never take effect and the poll
 * loop would outlive its watch (leaking one 20Hz loop per timeout).
 */
async function* followFile(
  file: string,
  fromOffset: number,
  isStopped: () => boolean,
): AsyncGenerator<string> {
  let offset = fromOffset;
  let buffer = "";
  while (!isStopped()) {
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size < offset) offset = 0; // truncated or rotated — follow from the top
    if (size > offset) {
      buffer += await Bun.file(file).slice(offset, size).text();
      offset = size;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      yield* parts;
    }
    await Bun.sleep(50);
  }
}

/**
 * Pins the journal read position BEFORE the announce marker is written, so
 * the "subscribe, then restart" ordering holds for the service mode too: a
 * follower spawned with plain `-f -n 0` only shows entries after journalctl
 * initializes, and an event logged in that window would be silently skipped.
 * Returns undefined when the unit has no journal entries yet (no cursor
 * exists to pin) — the caller follows un-pinned and says so loudly.
 */
export function parseJournalCursor(showCursorOutput: string): string | undefined {
  const match = showCursorOutput.match(/^-- cursor: (\S+)/m);
  return match?.[1];
}

export async function runWaitReady(args: WaitReadyArgs): Promise<WaitReadyResult> {
  const announce = () => {
    if (args.announce !== undefined) writeFileSync(args.announce, `${Date.now()}\n`);
  };

  if (args.source.type === "log") {
    const file = args.source.file;
    const fromOffset = existsSync(file) ? statSync(file).size : 0;
    let stopped = false;
    try {
      return await watchForEvent({
        lines: followFile(file, fromOffset, () => stopped),
        event: args.event,
        timeoutMs: args.timeoutMs,
        // The follow offset is already pinned — announcing now cannot race.
        onSubscribed: announce,
      });
    } finally {
      // Own and terminate the producer (here: the poll loop itself).
      stopped = true;
    }
  }

  const unit = args.source.unit;
  const cursorProbe = Bun.spawnSync(
    ["journalctl", "--user", "-u", unit, "-n", "0", "--show-cursor"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const cursor = parseJournalCursor(cursorProbe.stdout.toString());
  if (cursor === undefined) {
    // Loud, not silent: without a cursor (empty journal for this unit) the
    // attach window between spawn and follow start is not pinned.
    console.error(
      `wait-ready: no journal cursor available for ${unit}; following un-pinned (events logged before journalctl attaches may be missed)`,
    );
  }
  const producer = Bun.spawn(
    [
      "journalctl",
      "--user",
      "-u",
      unit,
      "-f",
      ...(cursor === undefined ? ["-n", "0"] : ["--after-cursor", cursor]),
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  try {
    return await watchForEvent({
      lines: linesOf(producer.stdout),
      event: args.event,
      timeoutMs: args.timeoutMs,
      // The cursor is pinned before the follower spawned — announce is safe.
      onSubscribed: announce,
    });
  } finally {
    // Own and terminate the producer — never leave a follower running.
    producer.kill();
    await producer.exited.catch(() => undefined);
  }
}

if (import.meta.main) {
  let args: WaitReadyArgs;
  try {
    args = parseWaitReadyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "usage: wait-ready (--service <unit> | --log <file>) --event <string> --timeout-ms <n> [--json] [--announce <marker-file>]",
    );
    process.exit(1);
  }
  const result = await runWaitReady(args);
  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.observed ? `observed: ${args.event}` : `timeout waiting for: ${args.event}`);
  }
  process.exit(result.observed ? 0 : 1);
}
