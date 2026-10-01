import { expect, spyOn } from "bun:test";

/** Return the writes made by a script while restoring process stdout afterward. */
export async function captureOutput(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return lines.join("");
}

/**
 * Run a lint `main` inside `root` expecting it to exit 1 with `violation` on stderr;
 * the process exit and stderr spies are restored afterward and `root` is left to the caller.
 */
export async function expectExitViolation(
  root: string,
  main: () => Promise<void>,
  violation: string,
): Promise<void> {
  const cwd = process.cwd();
  const errors: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  process.chdir(root);
  try {
    await expect(main()).rejects.toThrow("exit 1");
    expect(errors.join("")).toContain(violation);
  } finally {
    process.chdir(cwd);
    exit.mockRestore();
    stderr.mockRestore();
  }
}

/** Collect console.log/console.error messages until `restore` is called. */
export function captureConsole(): { readonly messages: string[]; readonly restore: () => void } {
  const messages: string[] = [];
  const error = spyOn(console, "error").mockImplementation((message: string) => {
    messages.push(message);
  });
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    messages.push(message);
  });
  return {
    messages,
    restore: () => {
      error.mockRestore();
      log.mockRestore();
    },
  };
}
