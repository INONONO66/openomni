import { Auth } from "@openomni/llm";
import type { ChatAgentConfig } from "@openomni/agent";
import type { Model } from "@openomni/protocol";
import { assistantMessage } from "./assistant-message";
import { providerFailure } from "./provider-failure";

/** Real SDK error shape, with retry facts on the error rather than under data. */
export function providerError(fields: {
  readonly message: string;
  readonly isRetryable: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
}): Error {
  return Object.assign(new Error(fields.message), {
    name: "AI_APICallError",
    isRetryable: fields.isRetryable,
    ...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
    ...(fields.responseBody === undefined ? {} : { responseBody: fields.responseBody }),
  });
}

export function transientProvider(
  resolved: Model.Ref[],
  auths?: Auth.Info[],
): ChatAgentConfig["llm"] {
  let calls = 0;
  return {
    resolveModel: async (model) => {
      resolved.push(model);
      return { id: model.id, name: model.id, providerID: model.provider };
    },
    run: async (input, sink) => {
      if (auths !== undefined)
        auths.push(await Auth.resolve(input.model.providerID, input.auth, input.authProvider));
      calls += 1;
      if (calls === 1) return { type: "error", error: providerFailure("transient blip") };
      sink.onMessage(assistantMessage(input, { call: calls, text: "recovered" }));
      return { type: "stop" };
    },
  };
}
