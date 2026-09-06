import { attachMachineDaemon } from "@openomni/machines";
import { createCodemode } from "@openomni/codemode";
import { Machine } from "@openomni/protocol";
import { z } from "zod";

const Configuration = z.object({ socketPath: z.string().min(1), offer: Machine.Offer }).strict();

/** Production composition of the existing daemon wire, not a second daemon implementation. */
export async function attachConfiguredMachine(configPath: string) {
  const config = Configuration.parse(JSON.parse(await Bun.file(configPath).text()));
  const mode = createCodemode();
  return attachMachineDaemon({ ...config, fsExports: new Map((config.offer.exports ?? []).map((entry) => [entry.name, entry.path])), runner: mode.runner });
}
