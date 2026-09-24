import { crashMatrixMain } from "./crash-matrix";
import { awaitCrashStart, holdCrashBarrier } from "./crash-channel";

if (import.meta.main) {
  awaitCrashStart();
  await crashMatrixMain(process.argv.slice(2), (witness) =>
    holdCrashBarrier(JSON.stringify(witness)),
  );
}
