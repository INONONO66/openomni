import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ensureGitignore(dir: string, pattern: string): void {
  const gitignorePath = join(dir, ".gitignore");

  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch (err: unknown) {
    if (
      !(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")
    ) {
      throw err;
    }
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(eol);

  const trimmedPattern = pattern.trim();
  const patternExists = lines.some((line) => line.trim() === trimmedPattern);

  if (patternExists) {
    return;
  }

  let newContent = content;
  if (content.length > 0 && !content.endsWith("\n") && !content.endsWith("\r\n")) {
    newContent += eol;
  }
  newContent += pattern + eol;

  writeFileSync(gitignorePath, newContent, "utf-8");
}
