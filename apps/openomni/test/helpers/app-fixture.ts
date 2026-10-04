import { Model, Bundle } from "@openomni/agent";
const Llm = Model.Llm;
const LlmLive = Model.LlmLive;
import { Context, Effect, Layer } from "effect";
import { composedHolderOf, type ComposedHolder } from "../../src/composition/composed";
import { createWatchPlane } from "../../src/composition/watch-plane";
import { gatewayRuntime } from "../../src/gateway";
import { readHooksJson } from "../../src/bundles/hooks-json";
import { appManifest } from "../../src/manifest";
import { startOpenOmni } from "../../src";
import { testEntropy } from "./test-entropy";
import { Bus } from "./bus";

/**
 * The PRODUCT composition for injected-runtime fixtures (#1255 P3): the same
 * `appManifest -> compose` boot runs, over a throwaway watch plane — the
 * composed tables (names, tools, rows, kinds) are what matter; the LIVE wake
 * router is always the booting process's own plane.
 */
async function productComposedHolder(
  off?: readonly string[],
  hooksPath?: string,
): Promise<ComposedHolder> {
  const plane = createWatchPlane();
  const manifest = appManifest({
    alarm: plane.contract,
    wake: plane.wake,
    ...(hooksPath === undefined ? {} : { hooks: readHooksJson(hooksPath) }),
    ...(off === undefined ? {} : { off }),
  });
  const generation = Bundle.composeSync(manifest);
  return composedHolderOf({ manifest, generation });
}

export type FixtureLlm = Context.Service.Shape<typeof Llm>;
type Start = NonNullable<Parameters<typeof startOpenOmni>[0]>;
export type AppFixtureOptions = Omit<Start, "sessionRuntime"> & {
  readonly llm?: Partial<FixtureLlm>;
  readonly sessionRuntime?: Start["sessionRuntime"] & {
    readonly clock?: () => number;
    readonly entropy?: () => string;
  };
  /** `"injected"` pins the cluster host's DeliverAt holds to the injected clock (#1255 P6). */
  readonly clusterClock?: "injected";
};

/** Test composition supplies services through the actual AppLive runtime. */
export async function appFixture(options: AppFixtureOptions) {
  if (options.config === undefined) throw new Error("fixture config required");
  const { llm, sessionRuntime, clusterClock, ...app } = options;
  const { clock, entropy, ...session } = sessionRuntime ?? {};
  const runtime =
    options.runtime ??
    gatewayRuntime({
      observations: Bus,
      composed: await productComposedHolder(options.config.bundlesOff, options.config.hooksPath),
      ...(options.config.catalogPath === undefined
        ? {}
        : { catalogPath: options.config.catalogPath }),
      ...(options.config.sessionsDir === undefined
        ? {}
        : { sessionsDir: options.config.sessionsDir }),
      ...(options.config.entityIdleMs === undefined
        ? {}
        : { entityIdleMs: options.config.entityIdleMs }),
      now: clock,
      ...(clusterClock === undefined ? {} : { clusterClock }),
      entropy: entropy === undefined ? undefined : testEntropy(entropy),
      llm: Layer.unwrap(
        Effect.map(Layer.build(LlmLive), (live) =>
          Layer.succeed(Llm, { ...Context.get(live, Llm), ...llm }),
        ),
      ),
    });
  return startOpenOmni({ ...app, runtime, sessionRuntime: session });
}
