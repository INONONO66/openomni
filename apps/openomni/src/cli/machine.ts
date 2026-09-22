import { Effect } from "effect";
import { attachMachineDaemon, ForeignFailure } from "@openomni/machines";
import { createCodemode } from "@openomni/codemode";
import { Machine } from "@openomni/protocol";
import { z } from "zod";
import { foreignFailure } from "../composition/failure";

const Configuration = z.object({ socketPath: z.string().min(1), offer: Machine.Offer }).strict();

/** Production composition of the existing daemon wire, not a second daemon implementation. */
export function attachConfiguredMachine(configPath: string) {
  return Effect.gen(function* () {
  const contents = yield* Effect.tryPromise({ try: () => Bun.file(configPath).text(), catch: foreignFailure((fields) => new ForeignFailure(fields), "configuration.read") });
  const config = yield* Effect.try({ try: () => Configuration.parse(JSON.parse(contents)), catch: foreignFailure((fields) => new ForeignFailure(fields), "configuration.decode") });
  const mode = yield* createCodemode();
  return yield* attachMachineDaemon({
    ...config,
    fsExports: new Map((config.offer.exports ?? []).map((entry) => [entry.name, entry.path])),
    runner: mode.runner,
  });
  });
}
