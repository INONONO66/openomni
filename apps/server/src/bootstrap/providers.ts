import { Auth, Provider } from "@openomni/llm";

export async function resolveModel(): Promise<Provider.Model | undefined> {
  try {
    const credentials = await Auth.all();
    const entries = Object.entries(credentials);
    if (entries.length === 0) return undefined;

    const providerID = entries[0][0];
    const auth = credentials[providerID];
    if (!auth) return undefined;

    const authType = auth.type === "oauth" ? "api" : auth.type;
    const models = await Provider.listModels(providerID, authType);
    return models[0];
  } catch (err) {
    console.warn("[server] failed to resolve model:", err instanceof Error ? err.message : err);
    return undefined;
  }
}
