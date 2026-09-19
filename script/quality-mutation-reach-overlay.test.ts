import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOverlay, encodeOverlay, reachPlugin, type ReachOverlay } from "./quality-mutation-reach-overlay";

type Load = (args: { path: string }) => { contents: string; loader: string };

test("reach overlay serves instrumented twins by resolved path and leaves the copy bytes alone", async () => {
	const root = mkdtempSync(join(tmpdir(), "omo-reach-overlay-"));
	const overlay: ReachOverlay = { root, instrumented: join(root, ".inst"), paths: ["src/a.ts", "src/b.mjs"] };
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(overlay.instrumented, "src"), { recursive: true });
	for (const path of overlay.paths) {
		writeFileSync(join(root, path), `export const original = ${JSON.stringify(path)};`);
		writeFileSync(join(overlay.instrumented, path), `export const probed = ${JSON.stringify(path)};`);
	}
	expect(decodeOverlay(encodeOverlay(overlay))).toEqual(overlay);
	expect(decodeOverlay(`${root}\n${overlay.instrumented}\n`).paths).toEqual([]);
	const loads: { filter: RegExp; load: Load }[] = [];
	reachPlugin(overlay).setup({ onLoad: (options: { filter: RegExp }, load: Load) => loads.push({ filter: options.filter, load }) } as never);
	const [registered] = loads;
	if (!registered) throw new Error("onLoad not registered");
	const resolved = realpathSync(root);
	expect(registered.filter.test(join(resolved, "src/a.ts"))).toBe(true);
	expect(registered.filter.test(join(resolved, "src/a.test.ts"))).toBe(false);
	expect(registered.filter.test(join(resolved, "src/c.ts"))).toBe(false);
	expect(registered.load({ path: join(resolved, "src/a.ts") })).toEqual({ contents: 'export const probed = "src/a.ts";', loader: "ts" });
	expect(registered.load({ path: join(resolved, "src/b.mjs") })).toEqual({ contents: 'export const probed = "src/b.mjs";', loader: "js" });
	expect(await Bun.file(join(root, "src/a.ts")).text()).toBe('export const original = "src/a.ts";');
});
