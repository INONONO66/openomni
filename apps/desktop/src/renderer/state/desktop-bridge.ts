import { z } from "zod";
import type { DesktopApi } from "../../preload/api";

const bridgeSchema = z.object({
  gateway: z.custom<DesktopApi["gateway"]>((value) => typeof value === "function"),
  onShellCommand: z.custom<DesktopApi["onShellCommand"]>((value) => typeof value === "function"),
});

/** Browser previews have no bridge; malformed bridges are configuration errors. */
export function desktopBridge() {
  return bridgeSchema.optional().parse(Reflect.get(typeof window === "undefined" ? globalThis : window, "desktop"));
}
