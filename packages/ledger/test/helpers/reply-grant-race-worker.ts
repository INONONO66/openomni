import { once } from "node:events";
import { z } from "zod";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

const [path, id] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
if (!process.send) throw new Error("reply-grant contender requires IPC");
const adapter = new SqliteStorageAdapter(path);
let result: "claimed" | "existing" | "capacity";
try {
  const start = once(process, "message", { signal: AbortSignal.timeout(10_000) });
  process.send("ready");
  const [command] = await start;
  if (command !== "claim") throw new Error("unexpected reply-grant race command");
  result = adapter.replyGrant.claim(
    {
      id,
      ruleId: "rule-1",
      senderId: "persona",
      targetActorId: id,
      operations: ["fire_and_forget"],
      replyScope: { surfaceKey: `telegram:${id}` },
      expiresAt: 100,
    },
    { at: 1, maxLiveInstances: 1 },
  );
} finally {
  adapter.close();
}
// Completion is observable only after checkpointing and closing this connection.
process.send({ type: "closed", result });
process.disconnect();
