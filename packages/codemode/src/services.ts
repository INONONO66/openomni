import { Context } from "effect";
import type { createCodemode } from "./index";

export class Codemode extends Context.Tag("@openomni/codemode/Codemode")<Codemode, {
  readonly create: typeof createCodemode;
}>() {}
