/**
 * Dependency-free five-field Vixie cron grid evaluated on an IANA zone's
 * wall clock (#1254 step 1). Protocol is Effect-free, so instants are epoch
 * milliseconds and the zone is an IANA name resolved through
 * `Intl.DateTimeFormat`. DST gap wall times are skipped; a wall time that
 * occurs twice fires only at its first instant.
 */

const MINUTE_MS = 60_000;
const SEARCH_BOUND_MS = 366 * 24 * 60 * MINUTE_MS;
const DAY_JUMP_SAFETY_MINUTES = 120;
const MONTH_NAMES: readonly string[] = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES: readonly string[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_FIELD = 3;
const DOW_FIELD = 4;

/** Typed refusal for an invalid expression, zone, or unreachable grid. */
export class CronParseError extends Error {
  constructor(
    readonly code: "fields" | "field" | "range" | "step" | "zone" | "unreachable",
    readonly field: number,
    readonly input: string,
  ) {
    super(`cron ${code} error (field ${field}): ${input}`);
    this.name = "CronParseError";
  }
}

type FieldSpec = { readonly set: ReadonlySet<number>; readonly restricted: boolean };
type Spec = {
  readonly minute: FieldSpec;
  readonly hour: FieldSpec;
  readonly dom: FieldSpec;
  readonly month: FieldSpec;
  readonly dow: FieldSpec;
};

function parseValue(token: string, index: number, input: string): number {
  if (index === MONTH_FIELD || index === DOW_FIELD) {
    const names = index === MONTH_FIELD ? MONTH_NAMES : DAY_NAMES;
    const named = names.indexOf(token.toLowerCase());
    if (named >= 0) {
      return index === MONTH_FIELD ? named + 1 : named;
    }
  }
  if (!/^\d+$/.test(token)) {
    throw new CronParseError("field", index, input);
  }
  return Number(token);
}

function parseItem(
  item: string,
  index: number,
  lo: number,
  hi: number,
  input: string,
  out: Set<number>,
): void {
  const [base = "", stepToken, stepExcess] = item.split("/");
  if (stepExcess !== undefined || (stepToken !== undefined && !/^[1-9]\d*$/.test(stepToken))) {
    throw new CronParseError("step", index, input);
  }
  const step = stepToken === undefined ? 1 : Number(stepToken);
  let from = lo;
  let to = hi;
  if (base !== "*") {
    const [rangeFrom = "", rangeTo, rangeExcess] = base.split("-");
    if (rangeExcess !== undefined) {
      throw new CronParseError("range", index, input);
    }
    from = parseValue(rangeFrom, index, input);
    to = rangeTo === undefined ? from : parseValue(rangeTo, index, input);
    if (rangeTo === undefined && stepToken !== undefined) {
      to = hi;
    }
  }
  if (from < lo || to > hi || from > to) {
    throw new CronParseError("range", index, input);
  }
  for (let value = from; value <= to; value += step) {
    out.add(index === DOW_FIELD && value === 7 ? 0 : value);
  }
}

function parseField(raw: string, index: number, lo: number, hi: number, input: string): FieldSpec {
  const set = new Set<number>();
  for (const item of raw.split(",")) {
    parseItem(item, index, lo, hi, input, set);
  }
  return { set, restricted: raw !== "*" };
}

function parse(expr: string): Spec {
  const fields = expr.trim().split(/\s+/);
  const [minute, hour, dom, month, dow] = fields;
  if (
    fields.length !== 5 ||
    minute === undefined ||
    hour === undefined ||
    dom === undefined ||
    month === undefined ||
    dow === undefined
  ) {
    throw new CronParseError("fields", fields.length, expr);
  }
  return {
    minute: parseField(minute, 0, 0, 59, expr),
    hour: parseField(hour, 1, 0, 23, expr),
    dom: parseField(dom, 2, 1, 31, expr),
    month: parseField(month, MONTH_FIELD, 1, 12, expr),
    dow: parseField(dow, DOW_FIELD, 0, 7, expr),
  };
}

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new CronParseError("zone", -1, tz);
  }
}

type Wall = {
  readonly minute: number;
  readonly hour: number;
  readonly dom: number;
  readonly month: number;
  readonly dow: number;
  readonly key: string;
};

function wallAt(format: Intl.DateTimeFormat, ms: number): Wall {
  const parts = new Map<string, string>();
  for (const part of format.formatToParts(ms)) {
    parts.set(part.type, part.value);
  }
  const read = (type: string): string => parts.get(type) ?? "";
  const key = `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
  return {
    minute: Number(read("minute")),
    hour: Number(read("hour")),
    dom: Number(read("day")),
    month: Number(read("month")),
    dow: DAY_NAMES.indexOf(read("weekday").toLowerCase()),
    key,
  };
}

/** Vixie day rule: dom and dow both restricted → OR; one restricted → AND. */
function dayMatches(spec: Spec, wall: Wall): boolean {
  const domHit = spec.dom.set.has(wall.dom);
  const dowHit = spec.dow.set.has(wall.dow);
  if (spec.dom.restricted && spec.dow.restricted) {
    return domHit || dowHit;
  }
  return (!spec.dom.restricted || domHit) && (!spec.dow.restricted || dowHit);
}

/** True when this wall minute already occurred earlier (DST overlap repeat). */
function isRepeatedWallMinute(format: Intl.DateTimeFormat, ms: number, key: string): boolean {
  return (
    wallAt(format, ms - 60 * MINUTE_MS).key === key || wallAt(format, ms - 30 * MINUTE_MS).key === key
  );
}

function nextAfterMinute(
  spec: Spec,
  format: Intl.DateTimeFormat,
  floorMs: number,
  expr: string,
): number {
  const bound = floorMs + SEARCH_BOUND_MS;
  let cursor = floorMs + MINUTE_MS;
  while (cursor <= bound) {
    const wall = wallAt(format, cursor);
    const hourJump = 60 - wall.minute;
    if (!(spec.month.set.has(wall.month) && dayMatches(spec, wall))) {
      const dayJump = (23 - wall.hour) * 60 + hourJump - DAY_JUMP_SAFETY_MINUTES;
      cursor += Math.max(hourJump, dayJump) * MINUTE_MS;
    } else if (!spec.hour.set.has(wall.hour)) {
      cursor += hourJump * MINUTE_MS;
    } else if (!spec.minute.set.has(wall.minute) || isRepeatedWallMinute(format, cursor, wall.key)) {
      cursor += MINUTE_MS;
    } else {
      return cursor;
    }
  }
  throw new CronParseError("unreachable", -1, expr);
}

export namespace Cron {
  /**
   * Next grid instant strictly after `fromMs` for a five-field Vixie
   * expression evaluated in IANA zone `tz`; returns epoch ms (UTC). `fromMs`
   * is floored to the minute; the result is strictly after that minute.
   */
  export function next(expr: string, fromMs: number, tz: string): number {
    return nextAfterMinute(
      parse(expr),
      zoneFormatter(tz),
      Math.floor(fromMs / MINUTE_MS) * MINUTE_MS,
      expr,
    );
  }

  /**
   * Grid instants in `(afterMs, untilMs]`, capped at `limit` (default 1024).
   * For a saturation-aware count (#1254 r2 M1) use `Cron.missed`.
   */
  export function occurrences(
    expr: string,
    afterMs: number,
    untilMs: number,
    tz: string,
    limit = 1024,
  ): readonly number[] {
    const spec = parse(expr);
    const format = zoneFormatter(tz);
    const hits: number[] = [];
    let cursor = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS;
    while (hits.length < limit) {
      const hit = nextAfterMinute(spec, format, cursor, expr);
      if (hit > untilMs) {
        break;
      }
      hits.push(hit);
      cursor = hit;
    }
    return hits;
  }

  /**
   * Counts grid instants in `(afterMs, untilMs]` without materializing them,
   * stopping at `limit` (default 1024). `saturated` is true iff at least one
   * further instant lies inside the window beyond the cap — a saturated
   * `count` means "at least this many", never an exact-looking truncation
   * (#1254 r2 M1).
   */
  export function missed(
    expr: string,
    afterMs: number,
    untilMs: number,
    tz: string,
    limit = 1024,
  ): { readonly count: number; readonly saturated: boolean } {
    const spec = parse(expr);
    const format = zoneFormatter(tz);
    let count = 0;
    let hit = nextAfterMinute(spec, format, Math.floor(afterMs / MINUTE_MS) * MINUTE_MS, expr);
    while (hit <= untilMs) {
      if (count === limit) {
        return { count, saturated: true };
      }
      count += 1;
      hit = nextAfterMinute(spec, format, hit, expr);
    }
    return { count, saturated: false };
  }
}
