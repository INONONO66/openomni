import { main } from "./bootstrap";
import { reportFatalAndExit } from "./bootstrap/fatal";

main().catch((error) => void reportFatalAndExit(error));
