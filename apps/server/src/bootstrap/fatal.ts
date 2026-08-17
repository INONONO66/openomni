import { Operational } from "@openomni/protocol";
import { BusPersistence } from "@openomni/session";
import { Bus, newTraceId } from "@openomni/telemetry";

/**
 * The terminal path for an unrecoverable error: report, then exit. The
 * telemetry flush between the two is the point — process.exit() discards
 * queued microtasks, so a publish immediately followed by exit never reaches
 * the ledger's observation rows. The barrier must also never block the
 * exit: a flush failure falls back to the stderr line that already went out.
 */
export async function reportFatalAndExit(
  error: unknown,
  exit: (code: number) => void = process.exit,
): Promise<void> {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // A boot that dies before BusPersistence.start() publishes into a
  // subscriber-less Bus — stderr is the only outlet that always exists.
  process.stderr.write(`openomni fatal: ${message}\n`);
  Bus.publish(Operational.Error, {
    traceId: newTraceId(),
    time: Date.now(),
    component: "server",
    msg: "fatal error",
    context: { err: error instanceof Error ? error.message : String(error) },
  });
  try {
    await BusPersistence.flush();
  } catch {
    // The observation row is best-effort on this path; stderr already spoke.
  }
  exit(1);
}
