import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import pkg from "../package.json";
import { AuthCommand } from "./cmd/auth";
import { ModelsDev } from "@openomni/llm";

ModelsDev.init();

await yargs(hideBin(process.argv))
  .scriptName("openomni")
  .help("help", "Show help")
  .alias("help", "h")
  .version("version", "Show version number", pkg.version)
  .alias("version", "v")
  .command(AuthCommand)
  .demandCommand(1, "Run a command. Try --help for usage.")
  .strict()
  .parseAsync();
