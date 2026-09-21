import { Context } from "effect";
import type { run } from "./run";
import type { Provider } from "./provider";

/** One attempt per invocation; retry admission belongs to the executor. */
export class Llm extends Context.Tag("@openomni/llm/Llm")<Llm, {
  readonly run: typeof run;
  readonly resolveModel: typeof Provider.resolveModel;
}>() {}
