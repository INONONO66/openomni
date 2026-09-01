import { arch, platform, release } from "node:os";

/**
 * The version this client reports to providers. A constant, not a runtime read
 * of package.json: this module is imported from `src/` in development and from
 * `dist/` after a build, so a relative manifest path is a different file on
 * each path (and a JSON import attribute is not portable across both). The
 * identity test pins this against the package manifest, so drift fails the
 * gate rather than shipping a lie in the header.
 */
const VERSION = "0.1.0";

/**
 * This client's wire identity, in exactly one format:
 * `pi/<version> (<platform> <kernelRelease>; <arch>)` — e.g.
 * `pi/0.1.0 (darwin 25.5.0; arm64)`.
 *
 * Single owner: every provider SDK instantiation takes its default
 * `user-agent` from here (see `sdk.ts`), so the fleet is identifiable from one
 * string rather than from whatever each call site remembered to set.
 */
export function clientIdentity(): string {
  return `pi/${VERSION} (${platform()} ${release()}; ${arch()})`;
}

/** The reported version, exposed so the manifest-sync gate can pin it. */
clientIdentity.version = VERSION;
