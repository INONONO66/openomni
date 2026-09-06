import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "@openomni/llm";
import { initialize, Storage } from "@openomni/ledger";
import { residentRunner as createResident } from "./helpers/resident-runner";
import { assistantMessage } from "./helpers/assistant-message";

const directories: string[] = [];

afterEach(() => {
	Storage.reset();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Resident compaction", () => {
	it("replaces oversized hydrated history before continuing the Resident run", async () => {
		const directory = mkdtempSync(join(tmpdir(), "openomni-resident-compaction-"));
		directories.push(directory);
		initialize({ dbPath: join(directory, "chat.db") });
		const sessionId = "resident-compaction";

		const seed = createResident({
			model: { provider: "fake", id: "resident-test" },
			apiKey: "test-key",
			tools: {},
			targets: () => [],
			llm: {
				resolveModel: async (model) => ({
					id: model.id,
					name: model.id,
					providerID: model.provider,
					limit: { context: 100_000 },
				}),
				run: async (input, sink: Sink) => {
					sink.onMessage(assistantMessage(input, { text: `seed answer ${"filler ".repeat(30)}` }));
					return { type: "stop" };
				},
			},
		});
		for (let index = 0; index < 6; index += 1) {
			await seed.prompt(sessionId, `seed question ${index} ${"filler ".repeat(30)}`);
		}

		const messageCounts: number[] = [];
		let calls = 0;
		const resident = createResident({
			model: { provider: "fake", id: "resident-test" },
			apiKey: "test-key",
			compaction: {
				contextWindowTokens: 700,
				elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
			},
			tools: {},
			targets: () => [],
			llm: {
				resolveModel: async (model) => ({
					id: model.id,
					name: model.id,
					providerID: model.provider,
					limit: { context: 700 },
				}),
				run: async (input, sink: Sink) => {
					calls += 1;
					messageCounts.push(input.messages?.length ?? 0);
					sink.onMessage(
						assistantMessage(input, {
							call: calls,
							reason: calls === 1 ? "tool-calls" : "stop",
							tokens: { input: 650, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
						}),
					);
					return { type: "stop" };
				},
			},
		});

		await resident.prompt(sessionId, "new resident question");

		expect(calls).toBe(2);
		expect(messageCounts[1]).toBeLessThan(messageCounts[0] ?? 0);
	});
});
