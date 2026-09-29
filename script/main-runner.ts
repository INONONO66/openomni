/**
 * Shared fatal-error tail for script entry points (#1116 patch-coverage gate):
 * a multi-line `if (import.meta.main) { try { await main(); } catch ... }`
 * block is dead weight no test can execute, so entry points delegate to this
 * covered helper and keep their guard on a single line.
 */
export async function runScriptMain(
  run: () => Promise<void>,
  exit: (code: number) => void = process.exit,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    exit(1);
  }
}
