#!/usr/bin/env bun
// #510 — FULL-durability decision-append benchmark (receipt evidence).
//
// Measures the real append core (packages/session ledger sub-adapter over a
// fresh SQLite file: PRAGMA synchronous=FULL on the decision connection,
// write-path hash chain, CAS head receipt) in the two production shapes:
//   - single-stream serialized appends (wait:/work: revision-bound CAS), and
//   - one fact per stream (route:/command: single-fact streams).
//
// Usage:
//   bun run script/bench-ledger-append.ts [--out <path>] [--n <appends>]
//
// The committed `script/bench-ledger-append.result.json` is the measured
// artifact cited by the #510 completion receipt; regenerate with --out to
// refresh it on a new baseline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../packages/session/src/index";

function parseArgs(argv: readonly string[]): { outPath?: string; n: number } {
  let outPath: string | undefined;
  let n = 2000;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--out" || flag === "--n") {
      if (value === undefined) {
        throw new Error(`missing value for ${flag} (usage: [--out <path>] [--n <appends>])`);
      }
      if (flag === "--out") outPath = value;
      else {
        n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw new Error("--n must be a positive integer");
      }
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag} (usage: [--out <path>] [--n <appends>])`);
    }
  }
  return { outPath, n };
}

async function gitHead(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  return out || "unknown";
}

if (import.meta.main) {
  const { outPath, n } = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "bench-ledger-append-"));
  try {
    Storage.initialize({ dbPath: join(dir, "bench.db") });
    const ledger = Storage.getAdapter().ledger;
    if (!ledger) throw new Error("storage adapter does not expose the ledger sub-adapter");

    for (let i = 0; i < 100; i += 1) {
      ledger.append({ streamId: "bench:warm", type: "bench.tick", data: { i } }, i);
    }

    let start = Bun.nanoseconds();
    for (let i = 0; i < n; i += 1) {
      const out = ledger.append({ streamId: "bench:s1", type: "bench.tick", data: { i } }, i);
      if (out.kind !== "appended") throw new Error("unexpected CAS conflict (single-stream)");
    }
    const singleMs = (Bun.nanoseconds() - start) / 1e6;

    start = Bun.nanoseconds();
    for (let i = 0; i < n; i += 1) {
      const out = ledger.append(
        { streamId: `bench:multi-${i}`, type: "bench.tick", data: { i } },
        0,
      );
      if (out.kind !== "appended") throw new Error("unexpected CAS conflict (multi-stream)");
    }
    const multiMs = (Bun.nanoseconds() - start) / 1e6;

    const result = {
      benchmark: "ledger-append-full-durability",
      measuredAt: new Date().toISOString(),
      commit: await gitHead(),
      platform: `${process.platform}/${process.arch} bun ${process.versions.bun}`,
      synchronous: "FULL (primary decision connection)",
      singleStream: {
        appends: n,
        totalMs: Math.round(singleMs),
        opsPerSec: Math.round((n / singleMs) * 1000),
        avgMsPerAppend: Number((singleMs / n).toFixed(3)),
      },
      multiStream: {
        appends: n,
        totalMs: Math.round(multiMs),
        opsPerSec: Math.round((n / multiMs) * 1000),
        avgMsPerAppend: Number((multiMs / n).toFixed(3)),
      },
    };

    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (outPath) {
      await Bun.write(outPath, serialized);
      console.log(`[bench-ledger-append] wrote ${outPath}`);
    }
    console.log(serialized);
    (Storage.getAdapter() as unknown as { close?: () => void }).close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
