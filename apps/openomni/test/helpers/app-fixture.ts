import { Llm, Provider, run } from "@openomni/llm";
import { Layer, type Context } from "effect";
import { gatewayRuntime } from "../../src/gateway";
import { startOpenOmni } from "../../src/index";

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
  const runtime = options.runtime ?? gatewayRuntime({
    ...(options.config.catalogPath === undefined ? {} : { catalogPath: options.config.catalogPath }),
    ...(options.config.sessionsDir === undefined ? {} : { sessionsDir: options.config.sessionsDir }),
    ...(options.config.entityIdleMs === undefined ? {} : { entityIdleMs: options.config.entityIdleMs }),
    clock, entropy,
    llm: Layer.succeed(Llm, { run, resolveModel: Provider.resolveModel, ...llm }),
  });
  return startOpenOmni({ ...app, runtime, sessionRuntime: session });
}
