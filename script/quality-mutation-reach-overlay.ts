import { copyFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import type { BunPlugin, Loader } from "bun";

/**
 * Reach probes are served at module load, never written into the reach copy.
 * Tests that read their own source as text (`Bun.file(join(SRC, "x.tsx"))`)
 * then keep matching the frozen bytes while imported modules carry the probes.
 * `BUN_OPTIONS=--preload` also carries the overlay into Bun children a test
 * spawns with an inherited environment. The preload is staged below a
 * `node_modules` directory: Bun's coverage reporters skip that tree, so a
 * child measuring its own fixture never records the overlay as a source that
 * escapes the fixture root.
 */
export type ReachOverlay = {
	/** Reach copy root; only files below it are overlaid. */
	root: string;
	/** Directory mirroring `root` with the instrumented sources. */
	instrumented: string;
	/** Root-relative paths that have an instrumented twin. */
	paths: string[];
};

const LOADERS: Record<string, Loader> = {
	".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
	".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};

export const OVERLAY_ENVIRONMENT = "QUALITY_MUTATION_REACH_OVERLAY";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Newline-separated overlay file: root, instrumented directory, then one path per line. */
export function encodeOverlay(overlay: ReachOverlay): string {
	return [overlay.root, overlay.instrumented, ...overlay.paths].join("\n");
}
export function decodeOverlay(text: string): ReachOverlay {
	const [root = "", instrumented = "", ...paths] = text.split("\n");
	return { root, instrumented, paths: paths.filter((path) => path !== "") };
}

export function reachPlugin(overlay: ReachOverlay): BunPlugin {
	// Bun hands onLoad the resolved path; macOS temp roots are symlinks.
	const root = realpathSync(overlay.root);
	const filter = new RegExp(`^(?:${overlay.paths.map((path) => escapeRegExp(join(root, path))).join("|")})$`);
	return {
		name: "quality-mutation-reach",
		setup(build) {
			build.onLoad({ filter }, ({ path }) => ({
				contents: readFileSync(join(overlay.instrumented, relative(root, path)), "utf8"),
				loader: LOADERS[extname(path)] ?? "ts",
			}));
		},
	};
}

/** Copies this module below `node_modules` under `directory` and returns the staged preload path. */
export function stagePreload(directory: string): string {
	const staged = join(directory, "node_modules", ".quality-mutation-reach", "overlay.ts");
	mkdirSync(dirname(staged), { recursive: true });
	copyFileSync(import.meta.path, staged);
	return staged;
}

/** Registers the overlay named by the environment; returns the overlaid paths (none when absent or empty). */
export function installOverlay(environment: Record<string, string | undefined>, register: (plugin: BunPlugin) => void): string[] {
	const overlayPath = environment[OVERLAY_ENVIRONMENT];
	if (!overlayPath) return [];
	const overlay = decodeOverlay(readFileSync(overlayPath, "utf8"));
	if (overlay.paths.length > 0) register(reachPlugin(overlay));
	return overlay.paths;
}

installOverlay(process.env, (plugin) => Bun.plugin(plugin));
