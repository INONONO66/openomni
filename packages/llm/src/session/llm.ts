import type { CoreMessage, StreamTextResult } from "ai";
import { streamText, generateText } from "ai";
import { Message } from "./message";
import { toModelMessages } from "./convert";
import { Retry } from "./retry";
import { Provider } from "../provider";
import { getProvider } from "../provider";
import { Auth } from "../auth/storage";

export namespace Stream {
  export interface StreamInput {
    model: Provider.Model;
    messages: Message.WithParts[];
    system?: string;
    abort?: AbortSignal;
    options?: {
      temperature?: number;
      maxTokens?: number;
    };
  }

  export interface GenerateInput {
    model: Provider.Model;
    messages: Message.WithParts[];
    system?: string;
    abort?: AbortSignal;
    options?: {
      temperature?: number;
      maxTokens?: number;
    };
  }

  export async function stream(
    input: StreamInput,
  ): Promise<StreamTextResult<any, unknown>> {
    return Retry.withRetry(
      async () => {
        const normalizedMessages = toModelMessages(input.messages, input.model);

        const systemMessages: CoreMessage[] = input.system
          ? [
              {
                role: "system",
                content: input.system,
              },
            ]
          : [];

        const auth = await Auth.get(input.model.providerID);
        if (!auth) {
          throw new Error(
            `No authentication found for provider: ${input.model.providerID}`,
          );
        }

        const provider = getProvider(input.model, auth);

        return streamText({
          model: provider,
          messages: [...systemMessages, ...normalizedMessages],
          temperature: input.options?.temperature,
          maxTokens: input.options?.maxTokens,
          abortSignal: input.abort,
        });
      },
      {
        signal: input.abort,
      },
    );
  }

  export async function generate(
    input: GenerateInput,
  ): Promise<Message.AssistantMessage> {
    const result = await Retry.withRetry(
      async () => {
        const normalizedMessages = toModelMessages(input.messages, input.model);

        const systemMessages: CoreMessage[] = input.system
          ? [
              {
                role: "system",
                content: input.system,
              },
            ]
          : [];

        const auth = await Auth.get(input.model.providerID);
        if (!auth) {
          throw new Error(
            `No authentication found for provider: ${input.model.providerID}`,
          );
        }

        const provider = getProvider(input.model, auth);

        return generateText({
          model: provider,
          messages: [...systemMessages, ...normalizedMessages],
          temperature: input.options?.temperature,
          maxTokens: input.options?.maxTokens,
          abortSignal: input.abort,
        });
      },
      {
        signal: input.abort,
      },
    );

    const now = Date.now();
    const assistantMessage: Message.AssistantMessage = {
      id: crypto.randomUUID(),
      sessionID: "",
      role: "assistant",
      time: {
        created: now,
        completed: now,
      },
      parentID: input.messages[input.messages.length - 1]?.info.id || "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "stream",
      path: {
        cwd: process.cwd(),
        root: process.cwd(),
      },
      cost: 0,
      tokens: {
        input: result.usage?.promptTokens || 0,
        output: result.usage?.completionTokens || 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      finish: result.finishReason,
    };

    return assistantMessage;
  }
}
