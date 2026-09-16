// Spawned by fs.test.ts: a FIFO request must settle in a fresh process so a
// blocking open would surface as a timeout there instead of hanging the suite.
import { Machine } from "@openomni/protocol";
import { createFsDriver } from "../../src/fs";

const [root, request] = process.argv.slice(2);
if (root === undefined || request === undefined) throw new Error("usage: fifo-request <root> <request-json>");
const driver = createFsDriver(new Map([["docs", root]]));
const result = await driver(Machine.FsRequest.parse(JSON.parse(request)));
driver.close();
process.stdout.write(JSON.stringify(result));
