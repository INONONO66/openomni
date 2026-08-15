import { newTraceId } from "@openomni/telemetry";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { main } from "./bootstrap";

main().catch((error) => {
  Bus.publish(Operational.Error, {
    traceId: newTraceId(),
    time: Date.now(),
    component: "server",
    msg: "fatal error",
    context: { err: error instanceof Error ? error.message : String(error) },
  });
  process.exit(1);
});
