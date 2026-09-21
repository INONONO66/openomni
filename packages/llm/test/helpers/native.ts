import { Cause, Effect, Exit, Option } from "effect";
import { Processor as NativeProcessor } from "../../src/processor";
import { run as nativeRun } from "../../src/run";
import { decodeLlmFailure } from "../../src/error";
export type { Run, RunInput } from "../../src/run";
export { LlmRunFailure } from "../../src/errors";

/** Only the test edge executes native effects; failures retain their tagged identity. */
export async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}
export namespace Processor {
  type StreamInput = Parameters<NativeProcessor.ProcessorOptions["createStream"]>[0];
  type Stream = Effect.Effect.Success<ReturnType<NativeProcessor.ProcessorOptions["createStream"]>>;
  export type ProcessorOptions = Omit<NativeProcessor.ProcessorOptions, "createStream"> & { createStream: (input: StreamInput) => Promise<Stream> };
  export function create(options: ProcessorOptions) {
    const value = NativeProcessor.create({ ...options, createStream: (input) => Effect.tryPromise({ try: () => options.createStream(input), catch: decodeLlmFailure("test.provider") }) });
    return { get message() { return value.message; }, get usageTotals() { return value.usageTotals; }, get visibleOutput() { return value.visibleOutput; }, process: (streamInput: { system: string; promptText: string }) => runEffect(value.process(streamInput)) };
  }
}
export function run(input: Parameters<typeof nativeRun>[0], sink: Parameters<typeof nativeRun>[1], dependencies: { createStream?: Processor.ProcessorOptions["createStream"] } = {}) {
  const createStream = dependencies.createStream;
  return runEffect(nativeRun(input, sink, createStream ? { createStream: (request) => Effect.tryPromise({ try: () => createStream(request), catch: decodeLlmFailure("test.provider") }) } : {}));
}
