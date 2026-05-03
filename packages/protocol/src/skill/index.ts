import { z } from "zod";

export namespace Skill {
  export const Layer = z.enum(["guarantee", "enhancement", "execution"]);
  export type Layer = z.infer<typeof Layer>;

  export const Scope = z.enum(["local", "global"]);
  export type Scope = z.infer<typeof Scope>;

  export const Definition = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    scope: Scope,
    layer: Layer,
    path: z.string(),
    useWhen: z.string().optional(),
    doNotUseWhen: z.string().optional(),
    finalChecklist: z.array(z.string()).optional(),
  });
  export type Definition = z.infer<typeof Definition>;

  export const RegistryEntry = z.object({
    id: z.string(),
    version: z.string(),
    installedAt: z.number(),
    source: z.string().optional(),
    enabled: z.boolean(),
  });
  export type RegistryEntry = z.infer<typeof RegistryEntry>;
}
