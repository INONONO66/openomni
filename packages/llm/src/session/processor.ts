import { Message } from "./message";
import { Retry } from "./retry";
import { APIError } from "../error";
import { Provider } from "../provider";

export namespace Processor {
  export interface ProcessorInfo {
    message: Message.AssistantMessage;
    process(streamInput: StreamInput): Promise<ProcessResult>;
  }

  export type ProcessResult = "stop" | "continue";

  export interface StreamInput {
    messages: unknown[];
    model: Provider.Model;
    system: string;
  }

  interface StreamEvent {
    type: string;
    [key: string]: unknown;
  }

  interface Stream {
    fullStream: AsyncIterable<StreamEvent>;
  }

  export function create(input: {
    assistantMessage: Message.AssistantMessage;
    sessionID: string;
    model: Provider.Model;
    abort: AbortSignal;
  }): ProcessorInfo {
    const assistantMessage = input.assistantMessage;
    const sessionID = input.sessionID;
    const model = input.model;
    const abort = input.abort;

    let attempt = 0;

    return {
      get message() {
        return assistantMessage;
      },

      async process(streamInput: StreamInput): Promise<ProcessResult> {
        while (true) {
          try {
            let currentText: Message.TextPart | undefined;
            const reasoningMap: Record<string, Message.ReasoningPart> = {};

            const stream = await mockStream(streamInput);

            for await (const event of stream.fullStream) {
              abort.throwIfAborted();

              switch (event.type) {
                case "text-start": {
                  const now = Date.now();
                  currentText = {
                    id: generateId("part"),
                    sessionID: assistantMessage.sessionID,
                    messageID: assistantMessage.id,
                    type: "text",
                    text: "",
                    time: {
                      start: now,
                    },
                    metadata:
                      (event.providerMetadata as Record<string, unknown>) || {},
                  };
                  break;
                }

                case "text-delta": {
                  if (currentText) {
                    currentText.text += String(event.text || "");
                    if (event.providerMetadata) {
                      currentText.metadata = event.providerMetadata as Record<
                        string,
                        unknown
                      >;
                    }
                  }
                  break;
                }

                case "text-end": {
                  if (currentText && currentText.time) {
                    currentText.text = currentText.text.trimEnd();
                    currentText.time = {
                      start: currentText.time.start,
                      end: Date.now(),
                    };
                    if (event.providerMetadata) {
                      currentText.metadata = event.providerMetadata as Record<
                        string,
                        unknown
                      >;
                    }
                  }
                  currentText = undefined;
                  break;
                }

                case "reasoning-start": {
                  const reasoningId = String(event.id);
                  if (!(reasoningId in reasoningMap)) {
                    const now = Date.now();
                    reasoningMap[reasoningId] = {
                      id: generateId("part"),
                      sessionID: assistantMessage.sessionID,
                      messageID: assistantMessage.id,
                      type: "reasoning",
                      text: "",
                      time: {
                        start: now,
                        end: undefined,
                      },
                      metadata:
                        (event.providerMetadata as Record<string, unknown>) ||
                        {},
                    };
                  }
                  break;
                }

                case "reasoning-delta": {
                  const reasoningId = String(event.id);
                  if (reasoningId in reasoningMap) {
                    const part = reasoningMap[reasoningId];
                    part.text += String(event.text || "");
                    if (event.providerMetadata) {
                      part.metadata = event.providerMetadata as Record<
                        string,
                        unknown
                      >;
                    }
                  }
                  break;
                }

                case "reasoning-end": {
                  const reasoningId = String(event.id);
                  if (reasoningId in reasoningMap) {
                    const part = reasoningMap[reasoningId];
                    part.text = part.text.trimEnd();
                    part.time = {
                      start: part.time.start,
                      end: Date.now(),
                    };
                    if (event.providerMetadata) {
                      part.metadata = event.providerMetadata as Record<
                        string,
                        unknown
                      >;
                    }
                    delete reasoningMap[reasoningId];
                  }
                  break;
                }

                case "step-start": {
                  break;
                }

                case "step-finish": {
                  const finishReason = String(event.finishReason || "end_turn");
                  assistantMessage.finish = finishReason;
                  break;
                }

                case "finish": {
                  break;
                }

                case "error": {
                  throw event.error;
                }

                default: {
                  break;
                }
              }
            }

            assistantMessage.time.completed = Date.now();
            return "stop";
          } catch (e: unknown) {
            const retryReason = Retry.isRetryable(e);

            if (retryReason !== undefined) {
              attempt++;
              const delayMs = Retry.delay(
                attempt,
                APIError.isInstance(e) ? e : undefined,
              );

              try {
                await Retry.sleep(delayMs, abort);
              } catch (sleepError) {
                if (
                  sleepError instanceof DOMException &&
                  sleepError.name === "AbortError"
                ) {
                  throw sleepError;
                }
                throw sleepError;
              }

              continue;
            }

            if (e instanceof DOMException && e.name === "AbortError") {
              throw e;
            }

            assistantMessage.time.completed = Date.now();
            return "stop";
          }
        }
      },
    };
  }

  function generateId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).substring(2, 11)}`;
  }

  async function mockStream(input: StreamInput): Promise<Stream> {
    return {
      fullStream: (async function* () {
        yield { type: "finish" };
      })(),
    };
  }
}
