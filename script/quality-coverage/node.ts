import childProcess from "node:child_process";
import * as modules from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// These ports consume only process identity and outcomes. Native options,
// streams, callbacks and IPC messages are forwarded, not decoded or rebuilt.
type Options = {
  env?: NodeJS.ProcessEnv;
  cwd?: string | URL;
  shell?: boolean | string;
};
type ForkOptions = Options & { execPath?: string; execArgv?: string[] };
type SyncOptions = Options & {
  stdio?: string | readonly (string | number | null | undefined | {
    readonly readable?: boolean;
    readonly writable?: boolean;
  })[];
};
// Native Error objects pass through intact. The port does not consume their
// optional, untyped cause payload.
type Error = { readonly name: string; readonly message: string; readonly stack?: string };
type Child = {
  readonly pid?: number;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): Child;
  once(event: "error", listener: (error: Error) => void): Child;
};
type Output = string | Buffer;
type Callback = (error: Error | null, stdout: Output, stderr: Output) => void;
type SyncResult = {
  readonly pid?: number;
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
  readonly stdout: Output | null;
  readonly stderr: Output | null;
  readonly output: (Output | null)[];
};
type Native = {
  spawn(command: string, args: string[], options?: Options): Child;
  spawnSync(command: string, args: string[], options?: Options): SyncResult;
  execFile(command: string, args: string[], options: Options, callback?: Callback | null): Child;
  fork(modulePath: string | URL, args: string[], options?: ForkOptions): Child;
};

const builtins: {
  Error: new (message: string) => Error;
  process: { readonly _eval?: string; once(event: "exit", listener: () => void): void };
} = globalThis;
const moduleLoader: {
  createRequire(path: string): (id: string) => {
    mock: { module(id: string, factory: () => Native & { default: Native }): void };
  };
} = modules;

export function installProcessHooks(
  wrap: (
    command: string[],
    env: NodeJS.ProcessEnv | undefined,
    cwd: string | undefined,
  ) => { id: string; command: string[]; env: NodeJS.ProcessEnv },
  observe: (id: string, code: number | null, signal: string | null) => void,
  reject: (code: string, path: string, message: string) => never,
): void {
  const native: Native = childProcess;
  const { spawn, spawnSync, execFile, fork } = native;
  let insideNative = false;
  let failed = false;

  function failure(path: string, message: string): void {
    process.exitCode = 2;
    if (failed) return;
    failed = true;
    // Keep the native error/throw available to its caller, but catching it
    // cannot turn an incomplete process boundary into a successful collection.
    builtins.process.once("exit", () => {
      try {
        reject("process", path, message);
      } finally {
        // Bun otherwise changes a throw from an exit listener into code 1.
        process.exit(2);
      }
    });
  }

  function prepare(command: string[], options: Options) {
    if (options.shell) {
      failure(command[0] ?? "", "shell execution is not observable");
      reject("unsupported_process", command[0] ?? "", "shell execution is not observable");
    }
    return wrap(
      command,
      options.env,
      options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
    );
  }

  function watch(child: Child, id: string): Child {
    child.once("exit", (code, signal) => observe(id, code, signal));
    child.once("error", (error: Error) => {
      // Abort and IPC errors after a successful launch do not replace exit.
      if (child.pid === undefined) {
        failure(id, error.message);
      }
    });
    return child;
  }

  function launch(run: () => Child, id: string): Child {
    let returned = false;
    insideNative = true;
    try {
      const child = run();
      returned = true;
      return watch(child, id);
    } finally {
      insideNative = false;
      if (!returned) failure(id, "native process launch threw");
    }
  }

  function sync(command: string, args: string[], options: Options): SyncResult {
    const wrapped = prepare([command, ...args], options);
    let returned = false;
    insideNative = true;
    try {
      const result = spawnSync(wrapped.command[0] ?? reject("process", command, "missing wrapped executable"), wrapped.command.slice(1), {
        ...options,
        env: wrapped.env,
      });
      returned = true;
      observe(wrapped.id, result.status, result.signal);
      if (result.error) failure(wrapped.id, result.error.message);
      return result;
    } finally {
      insideNative = false;
      if (!returned) failure(wrapped.id, "native synchronous launch threw");
    }
  }

  function hookedSpawn(command: string, args?: string[] | Options, options?: Options): Child {
    const hasArgs = args != null && "length" in args;
    const argv = hasArgs ? args : [];
    const opts = (hasArgs ? options : args) ?? options ?? {};
    if (insideNative) return spawn(command, argv, opts);
    const wrapped = prepare([command, ...argv], opts);
    return launch(
      () => spawn(wrapped.command[0] ?? reject("process", command, "missing wrapped executable"), wrapped.command.slice(1), { ...opts, env: wrapped.env }),
      wrapped.id,
    );
  }

  function hookedSpawnSync(command: string, args?: string[] | Options, options?: Options): SyncResult {
    const hasArgs = args != null && "length" in args;
    const argv = hasArgs ? args : [];
    const opts = (hasArgs ? options : args) ?? options ?? {};
    if (insideNative) return spawnSync(command, argv, opts);
    return sync(command, argv, opts);
  }

  function hookedExecFile(
    command: string,
    args?: string[] | Options | Callback | null,
    options?: Options | Callback | null,
    callback?: Callback | null,
  ): Child {
    const hasArgs = args != null && typeof args === "object" && "length" in args;
    const argv = hasArgs ? args : [];
    const opts = (
      hasArgs || args == null
        ? typeof options === "object" ? options : undefined
        : typeof args === "object" ? args : undefined
    ) ?? {};
    const cb = typeof args === "function" ? args : typeof options === "function" ? options : callback;
    if (insideNative) return execFile(command, argv, opts, cb);
    const wrapped = prepare([command, ...argv], opts);
    return launch(
      () => execFile(wrapped.command[0] ?? reject("process", command, "missing wrapped executable"), wrapped.command.slice(1), { ...opts, env: wrapped.env }, cb),
      wrapped.id,
    );
  }

  function hookedExecFileSync(
    command: string,
    args?: string[] | SyncOptions,
    options?: SyncOptions,
  ): Output | null {
    const hasArgs = args != null && "length" in args;
    const argv = hasArgs ? args : [];
    const opts = (hasArgs ? options : args) ?? options ?? {};
    // Native execFileSync is spawnSync plus stderr forwarding and its native
    // result attached to an Error. Use that result directly, including signals.
    const result = sync(command, argv, opts);
    if (!opts.stdio && result.stderr?.length) process.stderr.write(result.stderr);
    if (result.error) throw Object.assign(result.error, result);
    if (result.status !== 0) {
      const stderr = result.stderr?.length ? `\n${result.stderr}` : "";
      throw Object.assign(new builtins.Error(`Command failed: ${command}${argv.length ? ` ${argv.join(" ")}` : ""}${stderr}`), result);
    }
    return result.stdout;
  }

  function hookedFork(
    modulePath: string | URL,
    args?: string[] | ForkOptions,
    options?: ForkOptions,
  ): Child {
    const hasArgs = args != null && "length" in args;
    const argv = hasArgs ? args : [];
    const opts = (hasArgs ? options : args) ?? options ?? {};
    if (insideNative) return fork(modulePath, argv, opts);
    const entry = modulePath instanceof URL ? fileURLToPath(modulePath) : modulePath;
    let execArgv = opts.execArgv ?? process.execArgv;
    // Match native fork's removal of the parent's evaluation argument.
    if (execArgv === process.execArgv && builtins.process._eval !== undefined) {
      const index = execArgv.lastIndexOf(builtins.process._eval);
      if (index > 0) execArgv = [...execArgv.slice(0, index - 1), ...execArgv.slice(index + 1)];
    }
    const wrapped = prepare(
      [opts.execPath ?? process.execPath, ...execArgv, entry, ...argv],
      opts,
    );
    // wrap injects runtime preload arguments before the original entry/argv.
    // Keep fork native: it owns the IPC fd, serialization, stdio and callbacks.
    const entryIndex = wrapped.command.length - argv.length - 1;
    return launch(
      () => fork(wrapped.command[entryIndex] ?? reject("process", entry, "missing wrapped entry"), wrapped.command.slice(entryIndex + 1), {
        ...opts,
        execPath: wrapped.command[0],
        execArgv: wrapped.command.slice(1, entryIndex),
        env: wrapped.env,
      }),
      wrapped.id,
    );
  }

  function shell(command: string): never {
    failure(command, "shell execution is not observable");
    return reject("unsupported_process", command, "shell execution is not observable");
  }

  Object.defineProperties(childProcess, {
    spawn: { value: hookedSpawn },
    spawnSync: { value: hookedSpawnSync },
    execFile: { value: hookedExecFile },
    execFileSync: { value: hookedExecFileSync },
    fork: { value: hookedFork },
    exec: { value: shell },
    execSync: { value: shell },
  });
  syncBuiltinESMExports();
  if ("Bun" in globalThis) {
    // Both pinned Bun versions leave builtin ESM bindings unchanged in
    // syncBuiltinESMExports. Their synchronous module interposition API updates
    // existing named bindings while keeping this same mutable native object.
    const { mock } = moduleLoader.createRequire(import.meta.url)("bun:test");
    mock.module("node:child_process", () => ({ ...native, default: native }));
  }
}
