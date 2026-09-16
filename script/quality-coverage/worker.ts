import * as modules from "node:module";
import { syncBuiltinESMExports } from "node:module";
import * as workerThreads from "node:worker_threads";

type WorkerFilename = ConstructorParameters<typeof workerThreads.Worker>[0];
type WorkerOptions = ConstructorParameters<typeof workerThreads.Worker>[1];
type WorkerPreparation = {
	readonly id: string;
	readonly filename: WorkerFilename;
	readonly options: WorkerOptions | undefined;
};

const moduleLoader: {
	createRequire(path: string): {
		(id: "node:worker_threads"): {
			Worker: typeof workerThreads.Worker;
		};
		(id: "bun:test"): {
		mock: { module(id: string, factory: () => unknown): void };
		};
	};
} = modules;

export function installWorkerHooks(
	prepare: (
		filename: WorkerFilename,
		options: WorkerOptions | undefined,
	) => WorkerPreparation,
	observe: (id: string, code: number) => void,
	reject: (code: string, path: string, message: string) => never,
): void {
	const NativeWorker = workerThreads.Worker;
	class ObservedWorker extends NativeWorker {
		readonly #id: string;

		constructor(filename: WorkerFilename, options?: WorkerOptions) {
			const prepared = prepare(filename, options);
			super(prepared.filename, prepared.options);
			this.#id = prepared.id;
			let terminal = false;
			this.once("exit", (code) => {
				if (terminal) return;
				terminal = true;
				observe(this.#id, code);
			});
			this.once("error", (error) => {
				if (!terminal) reject("execution", this.#id, error.message);
			});
		}

		override unref(): void {
			reject("unsupported_process", this.#id, "worker unref is not observable");
		}
	}

	const nativeWorkerModule = moduleLoader.createRequire(import.meta.url)("node:worker_threads");
	nativeWorkerModule.Worker = ObservedWorker;
	syncBuiltinESMExports();
	if ("Bun" in globalThis) {
		const { mock } = moduleLoader.createRequire(import.meta.url)("bun:test");
		mock.module("node:worker_threads", () => ({
			...workerThreads,
			Worker: ObservedWorker,
			default: workerThreads,
		}));
	}
}
