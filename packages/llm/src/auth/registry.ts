import { Auth } from "./storage";

export type AuthMethod = {
  id: string;
  label: string;
  hint: string;
  run: (callbacks: AuthCallbacks) => Promise<void>;
};

export type AuthCallbacks = {
  showUrl: (url: string) => void;
  getInput: (message: string) => Promise<string>;
  showMessage: (message: string) => void;
  showProgress: (message: string) => void;
  stopProgress: (message: string) => void;
  updateProgress: (message: string) => void;
};

export type AuthProvider = {
  id: string;
  name: string;
  hint?: string;
  methods: AuthMethod[];
};

const anthropicProvider: AuthProvider = {
  id: "anthropic",
  name: "Anthropic",
  hint: "CLIProxy or API key",
  methods: [
    {
      id: "proxy",
      label: "CLIProxy",
      hint: "Connect via CLIProxyAPI (localhost proxy)",
      async run(cb) {
        const baseURL = await cb.getInput("CLIProxy URL (default: http://localhost:8317/v1)");
        const url = baseURL.trim() || "http://localhost:8317/v1";
        const apiKeyInput = await cb.getInput("CLIProxy API key (leave empty if none)");
        const apiKey = apiKeyInput.trim() || undefined;
        await Auth.set("anthropic", { type: "proxy", baseURL: url, ...(apiKey && { apiKey }) });
        cb.showMessage("Connected via CLIProxy");
      },
    },
    {
      id: "api",
      label: "API key",
      hint: "Use direct Anthropic API key",
      async run(cb) {
        const key = (await cb.getInput("Anthropic API key")).trim();
        if (!key) {
          cb.showMessage("No API key provided — skipped");
          return;
        }
        await Auth.set("anthropic", { type: "api", key });
        cb.showMessage("API key saved");
      },
    },
  ],
};

const openaiProvider: AuthProvider = {
  id: "openai",
  name: "OpenAI",
  hint: "CLIProxy or API key",
  methods: [
    {
      id: "proxy",
      label: "CLIProxy",
      hint: "Connect via CLIProxyAPI (localhost proxy)",
      async run(cb) {
        const baseURL = await cb.getInput("CLIProxy URL (default: http://localhost:8317/v1)");
        const url = baseURL.trim() || "http://localhost:8317/v1";
        const apiKeyInput = await cb.getInput("CLIProxy API key (leave empty if none)");
        const apiKey = apiKeyInput.trim() || undefined;
        await Auth.set("openai", { type: "proxy", baseURL: url, ...(apiKey && { apiKey }) });
        cb.showMessage("Connected via CLIProxy");
      },
    },
    {
      id: "api",
      label: "API key",
      hint: "Use direct OpenAI API key",
      async run(cb) {
        const key = (await cb.getInput("OpenAI API key")).trim();
        if (!key) {
          cb.showMessage("No API key provided — skipped");
          return;
        }
        await Auth.set("openai", { type: "api", key });
        cb.showMessage("API key saved");
      },
    },
  ],
};

const moonshotaiProvider: AuthProvider = {
  id: "moonshotai",
  name: "Moonshot AI",
  hint: "Moonshot AI (Kimi) API key",
  methods: [
    {
      id: "api",
      label: "API key",
      hint: "Use Moonshot AI API key",
      async run(cb) {
        const key = (await cb.getInput("Moonshot AI API key")).trim();
        if (!key) {
          cb.showMessage("No API key provided — skipped");
          return;
        }
        await Auth.set("moonshotai", { type: "api", key });
        cb.showMessage("API key saved");
      },
    },
  ],
};

const zhipuaiProvider: AuthProvider = {
  id: "zhipuai",
  name: "Zhipu AI",
  hint: "Zhipu AI (GLM) API key",
  methods: [
    {
      id: "api",
      label: "API key",
      hint: "Use Zhipu AI API key",
      async run(cb) {
        const key = (await cb.getInput("Zhipu AI API key")).trim();
        if (!key) {
          cb.showMessage("No API key provided — skipped");
          return;
        }
        await Auth.set("zhipuai", { type: "api", key });
        cb.showMessage("API key saved");
      },
    },
  ],
};

const registry: AuthProvider[] = [
  anthropicProvider,
  openaiProvider,
  moonshotaiProvider,
  zhipuaiProvider,
];

export function getAuthProviders(): AuthProvider[] {
  return registry;
}

export function getAuthProvider(id: string): AuthProvider | undefined {
  return registry.find((p) => p.id === id);
}
