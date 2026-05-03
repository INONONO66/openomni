import type { CommandModule } from "yargs";
import * as prompts from "@clack/prompts";
import { Auth, getAuthProviders, type AuthCallbacks } from "@openomni/llm";

function cancel(): never {
  prompts.cancel("Operation cancelled.");
  process.exit(0);
}

function createCallbacks(): AuthCallbacks {
  const spinner = prompts.spinner();
  return {
    showUrl(url) {
      prompts.log.info("Open this URL in your browser:");
      prompts.log.message(url);
    },
    async getInput(message) {
      const value = await prompts.text({
        message,
        validate: (v) => (v && v.length > 0 ? undefined : "Required"),
      });
      if (prompts.isCancel(value)) cancel();
      return value;
    },
    showMessage(message) {
      prompts.log.info(message);
    },
    showProgress(message) {
      spinner.start(message);
    },
    stopProgress(message) {
      spinner.stop(message);
    },
    updateProgress(message) {
      spinner.message(message);
    },
  };
}

async function loginApiKey(id: string, name: string) {
  const key = await prompts.password({
    message: `Enter your ${name} API key`,
    validate: (v) => (v && v.length > 0 ? undefined : "Required"),
  });
  if (prompts.isCancel(key)) cancel();

  await Auth.set(id, { type: "api", key });
  prompts.log.success(`${name} API key saved`);
}

const AuthLoginCommand: CommandModule = {
  command: "login",
  describe: "Log in to a provider",
  handler: async () => {
    prompts.intro("Add credential");

    const providers = getAuthProviders();

    const providerID = await prompts.select({
      message: "Select provider",
      options: [
        ...providers.map((p) => ({
          label: p.name,
          value: p.id,
          hint: p.hint,
        })),
        { label: "Other", value: "other", hint: "Enter API key manually" },
      ],
    });
    if (prompts.isCancel(providerID)) cancel();

    if (providerID === "other") {
      const customId = await prompts.text({
        message: "Enter provider id",
        validate: (v) => (v?.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
      });
      if (prompts.isCancel(customId)) cancel();

      await loginApiKey(customId, customId);
      prompts.outro("Done");
      return;
    }

    const provider = providers.find((p) => p.id === providerID);
    if (!provider) {
      prompts.log.error("Unknown provider");
      return;
    }

    const methods = provider.methods;
    let method = methods[0];
    if (method == null) {
      prompts.log.error("No login methods available");
      return;
    }

    if (methods.length > 1) {
      const selected = await prompts.select({
        message: "Select login method",
        options: methods.map((m) => ({
          label: m.label,
          value: m.id,
          hint: m.hint,
        })),
      });
      if (prompts.isCancel(selected)) cancel();
      method = methods.find((m) => m.id === selected) ?? method;
    }

    await method.run(createCallbacks());
    prompts.outro("Done");
  },
};

const AuthLogoutCommand: CommandModule = {
  command: "logout",
  describe: "Log out from a provider",
  handler: async () => {
    const credentials = await Auth.all();
    const entries = Object.entries(credentials);

    if (entries.length === 0) {
      prompts.log.error("No credentials found");
      return;
    }

    prompts.intro("Remove credential");

    const providerID = await prompts.select({
      message: "Select provider",
      options: entries.map(([key, value]) => ({
        label: `${key} (${value.type})`,
        value: key,
      })),
    });
    if (prompts.isCancel(providerID)) cancel();

    await Auth.remove(providerID);
    prompts.outro("Logout successful");
  },
};

const AuthListCommand: CommandModule = {
  command: "list",
  aliases: ["ls"],
  describe: "List stored credentials",
  handler: async () => {
    const credentials = await Auth.all();
    const entries = Object.entries(credentials);

    if (entries.length === 0) {
      prompts.log.info("No credentials stored");
      return;
    }

    prompts.intro("Credentials");
    for (const [key, value] of entries) {
      prompts.log.info(`${key} — ${value.type}`);
    }
    prompts.outro(`${entries.length} credential${entries.length === 1 ? "" : "s"}`);
  },
};

export const AuthCommand: CommandModule = {
  command: "auth",
  describe: "Manage credentials",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthLogoutCommand)
      .command(AuthListCommand)
      .demandCommand(1, "Run a subcommand. Try --help for usage."),
  handler: () => undefined,
};
