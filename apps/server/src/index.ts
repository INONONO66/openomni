import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createProductionComposition, main } from "./bootstrap";
import { loadConfig } from "./config";

main(createProductionComposition(loadConfig())).catch(() => {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "fatal error",
    context: { fatal: true },
  });
  process.exit(1);
});
