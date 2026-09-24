import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, FoldCheckpoint, NamedError, PlainValueSchema } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { sessionTree } from "../../ledger/test/helpers/session-tree";
import {
  FoldCheckpointIntegrityError,
  foldHistoryState,
  hydrateSessionHistory,
} from "../src/session-lifecycle/history";
import {
  reconstructionMain,
  reconstructionProcessMain,
  reconstructionWitness,
} from "./helpers/durable-reconstruction";
import { reconstructionSession } from "./helpers/reconstruction-fixture";
import { bounded } from "./helpers/bounded";

const worker = new URL("./helpers/durable-reconstruction.ts", import.meta.url).pathname;
const witnessSchema = reconstructionWitness;

/** The witness travels through a regular file: the child's stdout pipe is non-blocking on Linux. */
async function child(stage: string, dbPath: string) {
  const witnessPath = `${dbPath}.${stage}.witness.json`;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", worker, witnessPath, stage, dbPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await bounded(
      Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]),
      `reconstruction ${stage}`,
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("");
    return { code, value: JSON.parse(readFileSync(witnessPath, "utf8")) };
  } finally {
    process.kill();
  }
}

test("fresh-process checkpoint plus bounded suffix equals independent full replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fold-restart-"));
  try {
    const dbPath = join(directory, "kernel.sqlite");
    const written = await child("write", dbPath);
    expect(written.code).toBe(0);
    const cut = witnessSchema.parse(written.value);
    expect(cut.revision).toBeGreaterThan(256);
    const reopened = await child("read", dbPath);
    expect(reopened.code).toBe(0);
    const wake = witnessSchema.parse(reopened.value);
    expect(wake.digest).toBe(wake.oracle);
    expect(wake.stateDigest).toBe(wake.stateOracle);
    const checkpoint = wake.checkpoint;
    if (checkpoint === undefined) throw new Error("missing fold checkpoint");
    expect(FoldCheckpoint.Effect.parse(checkpoint.effect.value).result.foldVersion).toBe(1);
    expect(wake.ids.slice(1)).toEqual(["answer", "tool-message", "suffix"]);
    expect(
      wake.history.find((message) => message.info.id === "tool-message")?.parts,
    ).toContainEqual(
      expect.objectContaining({
        type: "tool",
        state: expect.objectContaining({ status: "completed", output: "settled" }),
      }),
    );
    const seeds = wake.actions
      .filter((action) => action.kind === "fold.checkpoint")
      .map((action) => FoldCheckpoint.Effect.parse(action.effect.value).result.state);
    expect(
      seeds.some((seed) =>
        seed.messages.some((message) =>
          message.parts.some((part) => part.type === "tool" && part.state.status === "pending"),
        ),
      ),
    ).toBe(true);
    expect(wake).toEqual(cut);
    expect(await child("read", dbPath)).toEqual(reopened);
    const captured = await child("wake", dbPath);
    expect(captured.code).toBe(0);
    const entry = witnessSchema.parse(captured.value);
    expect(entry.capture).toMatchObject({
      toolsGeneration: 1,
      recoveryUnchanged: true,
      context: {
        foldVersion: 1,
        sourceRevision: cut.revision,
        messageIds: cut.ids,
        projectionHash: canonicalDigest({
          foldVersion: 1,
          projection: PlainValueSchema.parse(cut.history),
        }),
      },
    });
    expect(entry.capture?.history).toEqual(cut.history);
    expect(entry.capture?.messages).toEqual(
      foldHistoryState(reconstructionSession, cut.actions).compatibility,
    );
    expect(entry.capture?.messages.map((message) => message.id)).toContain("prior-result");
    expect(entry.capture?.history.map((message) => message.info.id)).not.toContain("prior-result");
    const afterWake = await child("read", dbPath);
    const after = witnessSchema.parse(afterWake.value);
    expect(after.digest).toBe(cut.digest);
    expect(after.stateDigest).toBe(after.stateOracle);
    expect(after.actions.slice(0, cut.actions.length)).toEqual(cut.actions);
    expect(
      after.actions.flatMap((action) => SessionHandleStore.turnTerminal(action) ?? []),
    ).toHaveLength(
      cut.actions.flatMap((action) => SessionHandleStore.turnTerminal(action) ?? []).length,
    );
    expect(await child("read", dbPath)).toEqual(afterWake);
    const compaction = wake.actions
      .filter(
        (action) =>
          action.kind === "compaction" &&
          action.effect.value !== null &&
          typeof action.effect.value === "object" &&
          !Array.isArray(action.effect.value) &&
          action.effect.value.phase === "result",
      )
      .at(-1);
    expect(compaction).toBeDefined();
    expect(
      wake.actions.find((action) => action.ordinal === (compaction?.ordinal ?? 0) + 1)?.kind,
    ).toBe("fold.checkpoint");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const field of ["state", "stateHash", "foldVersion", "revision"] as const) {
  test(`fresh-process refuses tampered checkpoint ${field} before writes`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "fold-tamper-"));
    try {
      const dbPath = join(directory, "kernel.sqlite");
      const written = await child("write", dbPath);
      expect(written.code).toBe(0);
      const cut = witnessSchema.parse(written.value);
      if (cut.checkpoint === undefined) throw new Error("missing checkpoint");
      const db = new Database(dbPath);
      try {
        const value = {
          state: "invalid-seed",
          stateHash: "sha256:tampered",
          foldVersion: 2,
          revision: -1,
        }[field];
        db.query(
          `UPDATE action SET effect = json_set(effect, '$.result.${field}', ?) WHERE id = ?`,
        ).run(value, cut.checkpoint.id);
      } finally {
        db.close();
      }
      const refused = await child("wake", dbPath);
      expect(refused.code).toBe(1);
      expect(refused.value).toMatchObject({
        name: "FoldCheckpointIntegrityError",
        data: {
          code: "fold_checkpoint_integrity",
          reason: {
            state: "seed",
            stateHash: "stateHash",
            foldVersion: "version",
            revision: "revision",
          }[field],
          checkpointId: cut.checkpoint.id,
          sessionId: reconstructionSession,
        },
      });
      await Storage.withIsolation(() => {
        Storage.initialize({ dbPath });
        try {
          expect(SessionHandleStore.verifyChain(reconstructionSession).kind).toBe("broken");
          expect(SessionHandleStore.row(reconstructionSession).revision).toBe(cut.revision);
        } finally {
          Storage.reset();
        }
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("in-process reconstruction uses capped suffix reads and rejects a stale seed hash on an intact row chain", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "fold-in-process-"));
    try {
      const dbPath = join(directory, "kernel.sqlite");
      const written = await reconstructionMain("write", dbPath);
      expect(written.digest).toBe(written.oracle);
      expect(await reconstructionMain("read", dbPath)).toEqual(written);
      type Emitted = Parameters<Parameters<typeof reconstructionProcessMain>[1]>[0];
      const emitted: Emitted[] = [];
      const exited: number[] = [];
      const emit = (value: Emitted) => {
        emitted.push(value);
      };
      const exit = (code: number) => {
        exited.push(code);
      };
      await reconstructionProcessMain(["read", dbPath], emit, exit);
      expect(witnessSchema.parse(emitted.pop()).digest).toBe(written.digest);
      await reconstructionProcessMain(["wake", dbPath], emit, exit);
      expect(witnessSchema.parse(emitted.pop()).capture).toMatchObject({
        toolsGeneration: 1,
        recoveryUnchanged: true,
      });
      expect(exited).toEqual([0, 0]);
      await expect(reconstructionProcessMain([], emit, exit)).rejects.toThrow();
      await expect(
        reconstructionProcessMain(["read", `${dbPath}.other`], emit, exit),
      ).rejects.toThrow();
      const adapter = Storage.get().actions;
      if (adapter === undefined) throw new Error("missing action adapter");
      const range = adapter.range.bind(adapter);
      const limits: number[] = [];
      adapter.range = (id, cursor, limit) => {
        limits.push(limit);
        return range(id, cursor, limit);
      };
      const hydrated = hydrateSessionHistory(reconstructionSession);
      const oracle = foldHistoryState(reconstructionSession, sessionTree(reconstructionSession));
      expect(canonicalDigest(PlainValueSchema.parse(hydrated.state))).toBe(
        canonicalDigest(PlainValueSchema.parse(oracle)),
      );
      expect(limits.length).toBeGreaterThan(0);
      expect(limits.every((limit) => limit > 0 && limit <= 256)).toBe(true);
      const checkpoint = written.checkpoint;
      if (checkpoint === undefined) throw new Error("missing checkpoint");
      const revision = SessionHandleStore.row(reconstructionSession).revision;
      const effect = FoldCheckpoint.Effect.parse(checkpoint.effect.value);
      const corrupted = adapter.append(
        {
          id: "valid-chain-stale-seed",
          parentId: checkpoint.id,
          sessionId: reconstructionSession,
          kind: "fold.checkpoint",
          ts: 100,
          irreversible: true,
          intent: {
            encodingVersion: 1,
            value: { phase: "checkpoint", revision, foldVersion: 1, reason: "interval" },
          },
          effect: {
            encodingVersion: 1,
            value: PlainValueSchema.parse({
              ...effect,
              result: {
                ...effect.result,
                revision,
                state: {
                  ...effect.result.state,
                  canonicalTurn: !effect.result.state.canonicalTurn,
                },
              },
            }),
          },
        },
        revision,
      );
      expect(corrupted).toBeDefined();
      expect(SessionHandleStore.verifyChain(reconstructionSession).kind).toBe("intact");
      const before = sessionTree(reconstructionSession);
      try {
        hydrateSessionHistory(reconstructionSession);
        throw new Error("corrupt checkpoint accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(NamedError);
        expect(FoldCheckpointIntegrityError.isInstance(error)).toBe(true);
        if (!FoldCheckpointIntegrityError.isInstance(error)) throw error;
        expect(error.toObject()).toMatchObject({
          name: "FoldCheckpointIntegrityError",
          data: {
            code: "fold_checkpoint_integrity",
            reason: "stateHash",
            sessionId: reconstructionSession,
            checkpointId: "valid-chain-stale-seed",
            expected: effect.result.stateHash,
          },
        });
        expect(error.data.actual).toMatch(/^sha256:/);
        expect(error.data.actual).not.toBe(error.data.expected);
      }
      expect(sessionTree(reconstructionSession)).toEqual(before);
      await reconstructionProcessMain(["wake", dbPath], emit, exit);
      expect(emitted.pop()).toMatchObject({
        name: "FoldCheckpointIntegrityError",
        data: { reason: "stateHash" },
      });
      expect(exited).toEqual([0, 0, 1]);
    } finally {
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
