import { Layer } from "effect";
import { Provider } from "./provider";
import { run } from "./run";
import { Llm } from "./services";

export const LlmLive = Layer.succeed(Llm, { run, resolveModel: Provider.resolveModel });
