import { Layer } from "effect";
import { resolveAuthFilePath } from "./model/loader";
import { Provider } from "./provider";
import { run } from "./run";
import { Llm } from "./services";

/**
 * The credential file location is resolved once, when the Layer is built, and
 * closed over here (#1245): a later environment change cannot redirect the
 * credential reads and writes of a running service.
 */
export const LlmLive = Layer.sync(Llm, () => {
  const authFilePath = resolveAuthFilePath();
  return {
    run: (input, sink, dependencies) => run({ ...input, authFilePath }, sink, dependencies),
    resolveModel: (input) => Provider.resolveModel({ ...input, authFilePath }),
  };
});
