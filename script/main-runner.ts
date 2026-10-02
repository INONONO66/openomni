/**
 * Shared fatal-error tail for script entry points (#1116 patch-coverage gate):
 * a multi-line `if (import.meta.main) { try { await main(); } catch ... }`
 * block is dead weight no test can execute, so entry points delegate to this
 * covered helper and keep their guard on a single line.
 */

import { z } from "zod";

/** The printable text of a thrown value: an Error's message, anything else stringified. */
const causeText = z.union([
  z.instanceof(Error).transform((error) => error.message),
  z.coerce.string(),
]);

export async function runScriptMain(
  run: () => Promise<void>,
  exit: (code: number) => void = process.exit,
): Promise<void> {
  // `.then(run)` absorbs synchronous throws; `causeText.parse` by reference
  // keeps the rejection seam schema-typed instead of an owned `catch` binding.
  const failure = await Promise.resolve()
    .then(run)
    .then(() => null, causeText.parse);
  if (failure !== null) {
    process.stderr.write(`ERROR: ${failure}\n`);
    exit(1);
  }
}
