import { newTraceId } from "@openomni/telemetry";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { main } from "./bootstrap";

main().catch((error) => {
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
  process.exit(1);
});
