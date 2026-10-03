// #1276 layout contract: every plugin index exports its directory name (loader key).
export const name = "compaction" as const;
export { Compaction } from "./compact";
export type { CompactionOptions } from "./compact";
export { CompactionSession } from "./speculate";
