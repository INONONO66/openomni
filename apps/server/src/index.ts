import { Log } from "@openomni/session";
import { main } from "./bootstrap";

main().catch((error) => {
  Log.error("fatal error", { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
