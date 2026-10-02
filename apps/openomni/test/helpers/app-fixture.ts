import { Model } from "@openomni/agent";
const Llm = Model.Llm;
type Llm = Model.Llm;
const LlmLive = Model.LlmLive;
import { Context, Effect, Layer } from "effect";
import { gatewayRuntime } from "../../src/gateway";
import { startOpenOmni } from "../../src/index";
import { testEntropy } from "./test-entropy";
import { Bus } from "./bus";

export type FixtureLlm = Context.Service.Shape<typeof Llm>;
type Start = NonNullable<Parameters<typeof startOpenOmni>[0]>;
export type AppFixtureOptions = Omit<Start, "sessionRuntime"> & {
  readonly llm?: Partial<FixtureLlm>;
  readonly sessionRuntime?: Start["sessionRuntime"] & { readonly clock?: () => number; readonly entropy?: () => string };
};

/** Test composition supplies services through the actual AppLive runtime. */
export function appFixture(options: AppFixtureOptions) {
  if (options.config === undefined) throw new Error("fixture config required");
  const { llm, sessionRuntime, ...app } = options;
  const { clock, entropy, ...session } = sessionRuntime ?? {};
  const runtime = options.runtime ?? gatewayRuntime({ observations: Bus,
    ...(options.config.catalogPath === undefined ? {} : { catalogPath: options.config.catalogPath }),
    ...(options.config.sessionsDir === undefined ? {} : { sessionsDir: options.config.sessionsDir }),
    ...(options.config.entityIdleMs === undefined ? {} : { entityIdleMs: options.config.entityIdleMs }),
    now: clock,
    entropy: entropy === undefined ? undefined : testEntropy(entropy),
    llm: Layer.unwrap(Effect.map(Layer.build(LlmLive), (live) => Layer.succeed(Llm, { ...Context.get(live, Llm), ...llm }))),
  });
  return startOpenOmni({ ...app, runtime, sessionRuntime: session });
}
