import { expect, test } from "bun:test";
import { main } from "./verify-ledger-rename";

test("the repository carries zero old ledger identity", async () => {
  // main exits the process when any banned identity survives, so resolving at
  // all is the assertion; the scripts-contracts lane runs the same executable.
  await expect(main()).resolves.toBeUndefined();
});
