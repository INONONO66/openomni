import { ToolRefused } from "@openomni/agent";
import { Machine } from "@openomni/protocol";

export type Locus =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "machine"; readonly machine: string; readonly path: string };

/** A colon before the first slash introduces a machine id, including single-letter ids. */
export function parseLocus(path: string): Locus {
  if (path.length === 0 || path.includes("\0"))
    throw new ToolRefused("locus", "path must be nonempty and contain no NUL");
  if (path === "/machines" || path.startsWith("/machines/"))
    throw new ToolRefused("locus", "virtual machine roots are not supported");
  const colon = path.indexOf(":");
  const slash = path.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon)) return { kind: "local", path };
  const machine = path.slice(0, colon);
  const absolute = path.slice(colon + 1);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(machine) ||
    absolute.startsWith("//") ||
    !Machine.AbsolutePath.safeParse(absolute).success
  ) {
    throw new ToolRefused("locus", "expected machineId:/absolute/path");
  }
  return { kind: "machine", machine, path: absolute };
}
