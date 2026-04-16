import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ModelsDev } from "@openomni/llm";
import { SqliteTaskStore, TaskStorage } from "@openomni/openomni";
import { Storage } from "@openomni/session";
import pkg from "../package.json";
import { AgentCommand } from "./cmd/agent";
import { AuthCommand } from "./cmd/auth";
import { ConfigCommand } from "./cmd/config";
import { DaemonCommand } from "./cmd/daemon";

ModelsDev.init();
Storage.initialize({ dbPath: join(homedir(), ".openomni", "storage.db") });

const taskDir = join(homedir(), ".openomni", "tasks");
mkdirSync(taskDir, { recursive: true });
TaskStorage.configure(new SqliteTaskStore(join(taskDir, "tasks.db")));

await yargs(hideBin(process.argv))
  .scriptName("openomni")
  .help("help", "Show help")
  .alias("help", "h")
  .version("version", "Show version number", pkg.version)
  .alias("version", "v")
  .command(AgentCommand)
  .command(AuthCommand)
  .command(ConfigCommand)
  .command(DaemonCommand)
  .demandCommand(1, "Run a command. Try --help for usage.")
  .strict()
  .parseAsync();
