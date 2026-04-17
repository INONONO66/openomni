import type { CommandModule } from "yargs";
import { connectToDaemon } from "../client/websocket";

export const AgentCommand: CommandModule = {
  command: "agent",
  describe: "Start an agent session",
  builder: (yargs) =>
    yargs
      .option("mode", {
        choices: ["direct", "daemon"] as const,
        default: "daemon" as const,
        describe: "Run mode: connect to daemon (default) or local agent",
      })
      .option("session", {
        type: "string",
        describe: "Session ID to resume",
      }),
  handler: async (argv) => {
    const mode = (argv["mode"] as "direct" | "daemon") ?? "daemon";
    const session = argv["session"] as string | undefined;
    if (mode === "direct") {
      console.log("Direct mode: starting local agent...");
      return;
    }

    const wsUrl = process.env.OPENOMNI_WS_URL ?? "ws://localhost:9999";
    try {
      const client = await connectToDaemon(wsUrl);
      console.log("Connected to daemon. Type your message (Ctrl+C to exit):");

      client.onEvent((event) => {
        if (event.type === "chat.token") process.stdout.write(event.token);
        else if (event.type === "chat.done") console.log("\n[Done]");
        else if (event.type === "error") console.error(`Error: ${event.message}`);
      });

      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on("line", (line) => {
        client.send({ type: "chat.send", prompt: line, sessionId: session });
      });
      rl.on("close", () => {
        client.close();
        process.exit(0);
      });
    } catch (err) {
      console.error(`Failed to connect to daemon: ${err}`);
      console.error("Try: openomni daemon start");
      process.exit(1);
    }
  },
};
