import { z } from "zod";
import { gatewayEndpointSchema, shellCommandSchema } from "../../preload/validation";

const bridgeSchema = z.object({
  gateway: z.function({ input: [], output: z.promise(gatewayEndpointSchema) }),
  onShellCommand: z.function({
    input: [z.function({ input: [shellCommandSchema], output: z.void().catch(undefined) })],
    output: z.function({ input: [], output: z.void().catch(undefined) }),
  }),
});

/** Browser previews have no bridge; malformed bridges are configuration errors. */
export function desktopBridge() {
  return bridgeSchema.optional().parse(Reflect.get(typeof window === "undefined" ? globalThis : window, "desktop"));
}
