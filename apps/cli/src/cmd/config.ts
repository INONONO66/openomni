import type { CommandModule } from "yargs";
import * as prompts from "@clack/prompts";
import { Config } from "../config";

function cancel(): never {
  prompts.cancel("Operation cancelled.");
  process.exit(0);
}

async function promptUsers(): Promise<string[] | undefined> {
  const input = await prompts.text({
    message: "Allowed user IDs (comma-separated, empty for all)",
    placeholder: "Leave empty to allow everyone",
    defaultValue: "",
  });
  if (prompts.isCancel(input)) cancel();

  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// config add
// ---------------------------------------------------------------------------

const ConfigAddCommand: CommandModule = {
  command: "add",
  describe: "Configure an adapter",
  handler: async () => {
    prompts.intro("Configure adapter");

    const adapter = await prompts.select({
      message: "Select adapter",
      options: [
        { label: "Telegram", value: "telegram", hint: "Bot token" },
        {
          label: "GitHub",
          value: "github",
          hint: "Webhook secret + API token",
        },
        { label: "Discord", value: "discord", hint: "Bot token" },
      ],
    });
    if (prompts.isCancel(adapter)) cancel();

    switch (adapter) {
      case "telegram": {
        const token = await prompts.password({
          message: "Enter Telegram bot token",
          validate: (v) => (v && v.length > 0 ? undefined : "Required"),
        });
        if (prompts.isCancel(token)) cancel();

        const allowedUsers = await promptUsers();
        Config.setAdapter("telegram", {
          token,
          ...(allowedUsers && { allowedUsers }),
        });
        prompts.log.success("Telegram bot token saved");
        break;
      }

      case "github": {
        const secret = await prompts.password({
          message: "Enter GitHub webhook secret",
          validate: (v) => (v && v.length > 0 ? undefined : "Required"),
        });
        if (prompts.isCancel(secret)) cancel();

        const wantToken = await prompts.confirm({
          message: "Add GitHub API token? (for posting comments)",
        });
        if (prompts.isCancel(wantToken)) cancel();

        let token: string | undefined;
        if (wantToken) {
          const t = await prompts.password({
            message: "Enter GitHub API token",
            validate: (v) => (v && v.length > 0 ? undefined : "Required"),
          });
          if (prompts.isCancel(t)) cancel();
          token = t;
        }

        const allowedUsers = await promptUsers();
        Config.setAdapter("github", {
          secret,
          ...(token && { token }),
          ...(allowedUsers && { allowedUsers }),
        });
        prompts.log.success("GitHub credentials saved");
        break;
      }

      case "discord": {
        const token = await prompts.password({
          message: "Enter Discord bot token",
          validate: (v) => (v && v.length > 0 ? undefined : "Required"),
        });
        if (prompts.isCancel(token)) cancel();

        const allowedUsers = await promptUsers();
        Config.setAdapter("discord", {
          token,
          ...(allowedUsers && { allowedUsers }),
        });
        prompts.log.success("Discord bot token saved");
        break;
      }
    }

    prompts.outro("Done");
  },
};

// ---------------------------------------------------------------------------
// config list
// ---------------------------------------------------------------------------

const ConfigListCommand: CommandModule = {
  command: "list",
  aliases: ["ls"],
  describe: "List configured adapters",
  handler: async () => {
    const config = Config.load();
    const entries: string[] = [];

    if (config.telegram) {
      let line = `telegram — token: ${Config.mask(config.telegram.token)}`;
      if (config.telegram.allowedUsers?.length) {
        line += ` (${config.telegram.allowedUsers.length} allowed user(s))`;
      }
      entries.push(line);
    }
    if (config.github) {
      let line = `github  — secret: ${Config.mask(config.github.secret)}`;
      if (config.github.token) {
        line += `, token: ${Config.mask(config.github.token)}`;
      }
      if (config.github.allowedUsers?.length) {
        line += ` (${config.github.allowedUsers.length} allowed user(s))`;
      }
      entries.push(line);
    }
    if (config.discord) {
      let line = `discord — token: ${Config.mask(config.discord.token)}`;
      if (config.discord.allowedUsers?.length) {
        line += ` (${config.discord.allowedUsers.length} allowed user(s))`;
      }
      entries.push(line);
    }

    if (entries.length === 0) {
      prompts.log.info("No adapters configured. Run 'openomni config add'.");
      return;
    }

    prompts.intro("Configured adapters");
    for (const entry of entries) {
      prompts.log.info(entry);
    }
    prompts.outro(`${entries.length} adapter${entries.length === 1 ? "" : "s"}`);
  },
};

// ---------------------------------------------------------------------------
// config remove
// ---------------------------------------------------------------------------

const ConfigRemoveCommand: CommandModule = {
  command: "remove",
  aliases: ["rm"],
  describe: "Remove an adapter configuration",
  handler: async () => {
    const config = Config.load();
    const adapters: Array<{ label: string; value: string }> = [];

    if (config.telegram) adapters.push({ label: "Telegram", value: "telegram" });
    if (config.github) adapters.push({ label: "GitHub", value: "github" });
    if (config.discord) adapters.push({ label: "Discord", value: "discord" });

    if (adapters.length === 0) {
      prompts.log.info("No adapters configured.");
      return;
    }

    prompts.intro("Remove adapter");

    const selected = await prompts.select({
      message: "Select adapter to remove",
      options: adapters,
    });
    if (prompts.isCancel(selected)) cancel();

    Config.removeAdapter(selected as keyof Config.Adapters);
    prompts.outro(`${selected} configuration removed`);
  },
};

// ---------------------------------------------------------------------------
// config (parent)
// ---------------------------------------------------------------------------

export const ConfigCommand: CommandModule = {
  command: "config",
  describe: "Manage adapter configurations",
  builder: (yargs) =>
    yargs
      .command(ConfigAddCommand)
      .command(ConfigListCommand)
      .command(ConfigRemoveCommand)
      .demandCommand(1, "Run a subcommand. Try --help for usage."),
  handler: () => {},
};
