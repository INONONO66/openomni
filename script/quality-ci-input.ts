import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildInventory, readContract, digest, decodeJson, jsonObject, InventoryError, type Json,
} from "./quality-inventory";
import { qualitySource } from "./quality-source";
import { inventoryFrom } from "./quality-metrics/input";

export function readDocument(path: string): Json {
	return decodeJson(readFileSync(path, "utf8"));
}
export function fingerprint(root: string, contract: string) {
	const inventory = buildInventory(root, readContract(resolve(root, contract)));
	const paths = inventory.files.map((row) => row.path).filter(qualitySource);
	const resolved = inventoryFrom(root, Buffer.from(JSON.stringify(inventory)), contract);
	const embedded = resolved.embedded.map((source) => {
		const host = resolved.files.find((file) => file.path === source.hostPath);
		if (!host || source.hostOffset === undefined) throw new InventoryError("identity", source.path, "embedded host missing");
		return { path: source.path, hostPath: host.path, text: source.text, sha256: source.sha256, lineOffset: host.text.slice(0, source.hostOffset).split("\n").length - 1 };
	});
	return {
		embedded,
		inventory,
		inventoryHash: digest(JSON.stringify(inventory)),
		contractHash: inventory.contractHash,
		paths,
		schemaPaths: [...inventory.files.filter((row) => row.language === "sql" && row.category === "migration").map((row) => row.path), "sqlite_schema"],
		typescript: inventory.files.filter((row) =>
			qualitySource(row.path) && row.language === "typescript").map((row) => row.path),
	};
}
export function recordObject(path: string) {
	return jsonObject(readDocument(path));
}
