import { z } from "zod";
import { InventoryError, type Json } from "./quality-inventory";
import type { StaticDocument } from "./quality-ci-metrics";

const count = z.number().int().nonnegative();
const number = z.number().nonnegative();
const hash = z.hash("sha256");
const source = z.strictObject({
	path: z.string(), sha256: hash, bytes: count, category: z.string(), language: z.string(), text: z.string(),
	hostPath: z.string().optional(), hostOffset: count.optional(),
});
const position = z.strictObject({ line: count, column: count });
const range = z.strictObject({ start: position, end: position });
const span = z.strictObject({ start: count, end: count });
const unit = z.strictObject({
	path: z.string(), kind: z.string(), name: z.string(), start: count, end: count, body: span,
	line: count, column: count, endLine: count, endColumn: count, cyclomatic: count, cognitive: count, wrapperHash: hash,
	halstead: z.strictObject({
		algorithm: z.string(), n1: count, n2: count, N1: count, N2: count,
		difficulty: number, volume: number, effort: number,
		operators: z.record(z.string(), count), operands: z.record(z.string(), count),
	}),
});
const prepared = z.strictObject({
	path: z.string(), sha256: hash, mapHash: hash, code: z.string(), statementMap: z.record(z.string(), range),
	fnMap: z.record(z.string(), z.strictObject({ name: z.string(), decl: range, loc: range })),
});
const pythonProcess = z.strictObject({ pid: count, exitCode: z.literal(0), runtime: z.string(), outputHash: hash });
const clonePosition = z.strictObject({ line: count, column: count.optional(), position: count.optional() });
const duplicate = z.strictObject({
	sourceId: z.string(), start: clonePosition, end: clonePosition, range: z.tuple([count, count]),
});
const duplication = z.strictObject({
	settings: z.strictObject({
		mode: z.string(), minTokens: count, minLines: count, ignoreCase: z.boolean(), skipLocal: z.boolean(),
		gitignore: z.boolean(), ignore: z.array(z.never()), ignoreDirectives: z.boolean(), maxLines: count, maxSize: count,
	}),
	settingsHash: hash,
	inspected: z.array(z.strictObject({ path: z.string(), tokens: count, format: z.string() })),
	clusters: z.array(z.strictObject({
		id: hash, partition: z.array(z.string()), tokenHash: hash, tokenCount: count, settingsHash: hash, evidence: z.array(count),
		occurrences: z.array(z.strictObject({
			path: z.string(), startLine: count, endLine: count, start: count, end: count, sourceSha256: hash, category: z.string(),
		})),
	})),
	rawEvidence: z.array(z.strictObject({ format: z.string(), foundDate: count, duplicationA: duplicate, duplicationB: duplicate })),
	normalization: z.array(z.strictObject({ evidence: count, exactSpans: count, eligibleSpans: count })),
	production: count, test: count,
});
const staticSchema: z.ZodType<StaticDocument> = z.strictObject({
	version: z.literal(1), complete: z.literal(true), inventoryHash: hash, contractHash: hash,
	tools: z.array(z.strictObject({ name: z.string(), version: z.string(), packageHash: hash, entryHash: hash, invocation: z.string() })).min(1),
	analyzerProcesses: z.array(z.strictObject({ pid: count, exitCode: z.literal(0), operation: z.string(), inputHash: hash, outputHash: hash })).min(1),
	pythonProcesses: z.array(pythonProcess),
	sources: z.array(z.strictObject({ path: z.string(), sha256: hash })).min(1),
	hosts: z.array(source).min(1),
	measured: z.array(z.strictObject({ source, analysis: z.strictObject({ units: z.array(unit), prepared, receipt: pythonProcess.nullable() }) })).min(1),
	duplication,
});

/** Artifacts cross a JSON boundary; a type annotation on BunFile.json() would
 * silently trust missing arrays or malformed analyzer values as measurements. */
export function parseStatic(value: Json): StaticDocument {
	const result = staticSchema.safeParse(value);
	if (!result.success) throw new InventoryError("measurement", "", "invalid static metrics");
	return result.data;
}
