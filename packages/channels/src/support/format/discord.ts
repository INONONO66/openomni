/**
 * Standard markdown -> Discord. Discord renders its own markdown subset
 * natively; the only construct it cannot draw is a GFM pipe table, so tables
 * are rewritten to bold-heading bullet groups and everything else passes
 * through untouched.
 */

import { tablesToBullets } from "./table";

export function renderDiscordMarkdown(markdown: string): string {
  return tablesToBullets(markdown);
}
