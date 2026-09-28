import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { MessageStorage, Sharding, SingleRunner } from "effect/cluster";
import { BunCrypto } from "./crypto.ts";

const file = process.argv[2] ?? "/tmp/w5-spike-smoke.db";
const SqlLive = SqliteClient.layer({ filename: file });
const ClusterLive = SingleRunner.layer({ runnerStorage: "sql" }).pipe(
  Layer.provide(SqlLive),
  Layer.provide(BunCrypto),
);
const program = Effect.gen(function* () {
  const sharding = yield* Sharding.Sharding;
  const storage = yield* MessageStorage.MessageStorage;
  return { ok: true, sharding: typeof sharding, storage: typeof storage, file };
});
console.log(
  JSON.stringify(await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(ClusterLive))))),
);
