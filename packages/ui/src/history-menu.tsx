import { Menu } from "@base-ui/react/menu";
import { History } from "lucide-react";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { Text } from "./primitives/surface";

/** One place the main column has been: an id to jump to, a title, and when. */
export interface HistoryEntry {
  readonly id: string;
  readonly title: string;
  /** Epoch ms. */
  readonly at: number;
}

/** The menu lists this many, newest first; the stack behind it may be longer. */
const HISTORY_MENU_LIMIT = 20;

/**
 * The clock: a Base UI menu over the last twenty places, newest first, the
 * current one marked. Each place is ONE line — the title, then how long ago in
 * the ambient tone on the right — so the list reads as a ledger of where the
 * eye has been, not as a second navigator.
 *
 * `now` is a prop rather than `Date.now()` read here: the relative times are
 * then a pure function of the entries, which is what lets them be rendered to
 * static markup and asserted on.
 */
export function HistoryMenu({
  entries,
  currentId,
  now,
  onJump,
}: {
  readonly entries: readonly HistoryEntry[];
  readonly currentId: string | null;
  readonly now: number;
  readonly onJump: (id: string) => void;
}) {
  const recent = entries.slice(-HISTORY_MENU_LIMIT).reverse();
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="History" size="sm" />}>
        <History />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          align="start"
          className="z-(--z-overlay-content)"
          side="bottom"
          sideOffset={4}
        >
          <Menu.Popup
            className="min-w-56 rounded-card border-[0.5px] border-line-surface bg-raised p-1 outline-none"
            data-ui={UI_NAMES.HistoryMenu}
          >
            {recent.length === 0 ? (
              <Menu.Item className={ITEM} data-ui={UI_NAMES.HistoryMenuItem} disabled>
                <Text level="label" tone="faint">
                  No history
                </Text>
              </Menu.Item>
            ) : (
              recent.map((entry) => {
                const current = entry.id === currentId;
                return (
                  <Menu.Item
                    aria-current={current ? "true" : undefined}
                    className={`${ITEM} ${current ? "bg-hover text-fg" : "text-fg-muted"}`}
                    data-ui={UI_NAMES.HistoryMenuItem}
                    key={entry.id}
                    onClick={() => onJump(entry.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    <Text className="shrink-0" level="meta" mono numeric tone="faint">
                      {relativeTime(entry.at, now)}
                    </Text>
                  </Menu.Item>
                );
              })
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const ITEM =
  "flex h-7 cursor-default select-none items-center gap-3 rounded-sm px-2 text-label outline-none data-highlighted:bg-hover data-highlighted:text-fg data-disabled:pointer-events-none";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `now`, then `5m`, `3h`, `2d`: the coarsest unit that is at least one. */
export function relativeTime(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}
