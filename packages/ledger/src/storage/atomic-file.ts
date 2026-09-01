import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { IdSource } from "@openomni/protocol";

export interface AtomicFileOptions {
  readonly mode?: number;
  readonly durable?: boolean;
  readonly temporaryId?: IdSource;
  readonly replace?: (temporaryPath: string, finalPath: string) => void;
}

/**
 * Makes complete bytes visible in one rename, cleaning the exclusive temporary
 * file on every failure. Durable writes additionally sync the file and parent
 * directory around the rename.
 */
export function replaceFileAtomically(
  path: string,
  contents: string | Uint8Array,
  options: AtomicFileOptions = {},
): void {
  const directory = dirname(path);
  const temporaryId = options.temporaryId ?? (() => randomUUID());
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${temporaryId()}.tmp`,
  );

  try {
    const descriptor = openSync(temporaryPath, "wx", options.mode);
    try {
      writeFileSync(descriptor, contents);
      if (options.durable) fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    (options.replace ?? renameSync)(temporaryPath, path);

    if (options.durable) {
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
