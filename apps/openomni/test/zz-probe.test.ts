import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Effect } from "effect";
import { messageFixture } from "./helpers/message-fixture";
import { sessionFilePath } from "../src/composition/cluster-runtime";
import { storageDirectories } from "./helpers/storage-directories";
import { runEffect } from "./helpers/effect";
import { Bus, ObservationSink } from "@openomni/agent";

const directories = storageDirectories(true);

function sessionDb(fixture: { directory: string }, sessionId: string) {
  return sessionFilePath(join(fixture.directory, "sessions"), sessionId);
}

test("probe corrupted evidence surfaces", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  using db = new Database(sessionDb(fixture, fixture.sessionId));
  db.exec(
    `CREATE TRIGGER corrupt_decision AFTER INSERT ON action WHEN NEW.kind = 'policy.decision' BEGIN UPDATE action SET intent = json_remove(intent, '$.inputHash') WHERE id = NEW.id; END`,
  );
  const result = await fixture.send({
    to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
    type: "message",
    content: "corrupt-evidence",
  });
  console.log("OUTCOME result", JSON.stringify(result));
  try {
    const { sessionTree } = await import("../../../packages/ledger/test/helpers/session-tree");
    const rows = sessionTree(fixture.sessionId, fixture.plane.sessionStore(fixture.sessionId).actions);
    for (const row of rows) console.log("OUTCOME action", row.kind, JSON.stringify(row.effect).slice(0, 400));
  } catch (error) {
    console.log("OUTCOME tree-error", String(error));
  }
});
