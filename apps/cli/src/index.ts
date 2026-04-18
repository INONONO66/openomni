import { homedir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ModelsDev } from "@openomni/llm";
import { Storage } from "@openomni/session";
import pkg from "../package.json";
import { AuthCommand } from "./cmd/auth";
import { ConfigCommand } from "./cmd/config";

ModelsDev.init();
Storage.initialize({ dbPath: join(homedir(), ".openomni", "storage.db") });

await yargs(hideBin(process.argv))
  .scriptName("openomni")
  .help("help", "Show help")
  .alias("help", "h")
  .version("version", "Show version number", pkg.version)
  .alias("version", "v")
  .command(AuthCommand)
  .command(ConfigCommand)
  .demandCommand(1, "Run a command. Try --help for usage.")
  .strict()
  .parseAsync();
