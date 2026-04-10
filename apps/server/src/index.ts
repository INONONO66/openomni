import { main } from "./bootstrap";

main().catch((error) => {
  console.error("[server] fatal error:", error);
  process.exit(1);
});
