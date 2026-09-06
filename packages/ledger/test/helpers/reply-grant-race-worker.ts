import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

const input = z.object({
	path: z.string(),
	id: z.string(),
	gate: z.instanceof(SharedArrayBuffer),
}).parse(workerData);
if (parentPort === null) throw new Error("reply-grant worker requires a parent");
const adapter = new SqliteStorageAdapter(input.path);
try {
	parentPort.postMessage("ready");
	Atomics.wait(new Int32Array(input.gate), 0, 0);
	const result = adapter.replyGrant.claim({
		id: input.id, ruleId: "rule-1", senderId: "persona", targetActorId: input.id,
		operations: ["fire_and_forget"], replyScope: { surfaceKey: `telegram:${input.id}` },
		expiresAt: 100,
	}, { at: 1, maxLiveInstances: 1 });
	parentPort.postMessage(result);
} finally {
	adapter.close();
	parentPort.close();
}
