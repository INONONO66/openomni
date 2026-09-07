import type { IClone, IToken } from "@jscpd/core";
import { array, object, integer, text, fail, sha, type Json, type Source } from "./input";
import { invokeTool } from "./tool";

function position(value: Json | undefined) {
  const p = object(value);
  return {
    line: integer(p.line),
    ...(p.column === undefined ? {} : { column: integer(p.column) }),
    ...(p.position === undefined ? {} : { position: integer(p.position) }),
  };
}
function range(value: Json | undefined): [number, number] {
  const r = array(value);
  if (r.length !== 2) fail("clones", "", "invalid engine range");
  return [integer(r[0]), integer(r[1])];
}
function clone(value: Json): IClone {
  const c = object(value);
  function duplicate(value: Json | undefined) {
    const d = object(value);
    return {
      sourceId: text(d.sourceId),
      start: position(d.start),
      end: position(d.end),
      range: range(d.range),
    };
  }
  return {
    format: text(c.format),
    foundDate: integer(c.foundDate),
    duplicationA: duplicate(c.duplicationA),
    duplicationB: duplicate(c.duplicationB),
  };
}
function token(value: Json): IToken {
  const t = object(value),
    loc = object(t.loc);
  return {
    type: text(t.type),
    value: text(t.value),
    format: text(t.format),
    length: integer(t.length),
    range: range(t.range),
    loc: { start: position(loc.start), end: position(loc.end) },
  };
}

export type Occurrence = {
  path: string;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
  sourceSha256: string;
  category: string;
};
export type Cluster = {
  id: string;
  partition: string[];
  tokenHash: string;
  tokenCount: number;
  settingsHash: string;
  occurrences: Occurrence[];
  evidence: number[];
};
function format(source: Source): string {
  if (source.language === "typescript" && source.path.endsWith(".tsx")) return "tsx";
  if (source.language === "javascript" && source.path.endsWith(".jsx")) return "jsx";
  return source.language;
}
function key(o: Occurrence): string {
  return `${o.path}\0${o.start}\0${o.end}`;
}
type TokenSpan = { source: Source; tokens: IToken[]; start: number; end: number };
function occurrence(span: TokenSpan, start: number, end: number): Occurrence {
  const first = span.tokens[start],
    last = span.tokens[end - 1];
  if (!first?.loc || !last?.loc) fail("clones", span.source.path, "missing engine token location");
  return {
    path: span.source.path,
    startLine: first.loc.start.line,
    endLine: last.loc.end.line,
    start: first.range[0],
    end: last.range[1],
    sourceSha256: span.source.sha256,
    category: span.source.category,
  };
}
/** Normalize only spans nominated by the pinned engine. RabinKarp can join
 * consecutive A frames whose B frames are nonconsecutive; its look-ahead end
 * also includes an unhashed token. Split those raw ranges into maximal EXACT
 * equal spans, extending a nominated seed through equal surrounding tokens.
 * Never nominate a source pair or seed outside the engine's evidence. */
function equalSpans(a: TokenSpan, b: TokenSpan, minTokens: number) {
  const left = a.tokens.map((t) => JSON.stringify([t.type, t.value]));
  const right = b.tokens.map((t) => JSON.stringify([t.type, t.value]));
  const windows = new Map<string, number[]>();
  for (let j = b.start; j + minTokens <= b.end; j++) {
    const key = JSON.stringify(right.slice(j, j + minTokens));
    const offsets = windows.get(key) ?? [];
    offsets.push(j);
    windows.set(key, offsets);
  }
  const spans = new Map<
    string,
    { tokenHash: string; tokenCount: number; occurrences: Occurrence[] }
  >();
  for (let i = a.start; i + minTokens <= a.end; i++) {
    for (const j of windows.get(JSON.stringify(left.slice(i, i + minTokens))) ?? []) {
      if (i > a.start && j > b.start && left[i - 1] === right[j - 1]) continue;
      let before = 0;
      while (i > before && j > before && left[i - before - 1] === right[j - before - 1]) before++;
      let length = minTokens;
      while (
        i + length < left.length &&
        j + length < right.length &&
        left[i + length] === right[j + length]
      )
        length++;
      const first = occurrence(a, i - before, i + length),
        second = occurrence(b, j - before, j + length);
      if (key(first) === key(second)) continue;
      const tokenHash = sha(
        JSON.stringify(a.tokens.slice(i - before, i + length).map((t) => [t.type, t.value])),
      );
      spans.set(`${key(first)}\0${key(second)}`, {
        tokenHash,
        tokenCount: length + before,
        occurrences: [first, second],
      });
    }
  }
  return [...spans.values()];
}
export async function detectClones(sources: Source[]) {
  const settings = {
    mode: "weak",
    minTokens: 50,
    minLines: 5,
    ignoreCase: false,
    skipLocal: false,
    gitignore: false,
    ignore: [],
    ignoreDirectives: false,
    maxLines: Math.max(0, ...sources.map((s) => s.text.split(/\r?\n/).length)) + 1,
    maxSize: Math.max(0, ...sources.map((s) => s.bytes)) + 1,
  };
  const settingsHash = sha(JSON.stringify(settings));
  const inputs = [...sources]
    .sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)))
    .map((source) => {
      if (/jscpd\s*:\s*ignore|jscpd[-\s]+ignore/i.test(source.text))
        fail("directive", source.path, "clone ignore directive forbidden");
      return { path: source.path, text: source.text, format: format(source) };
    });
  const result = object(invokeTool({ operation: "clones", sources: inputs, settings }));
  const raw = array(result.raw).map(clone);
  const counts = new Map<string, number>();
  const tokenMap = new Map(
    array(result.tokens).map((value) => {
      const row = object(value);
      counts.set(text(row.path), integer(row.count));
      return [text(row.path), array(row.tokens).map(token)] as const;
    }),
  );
  if (tokenMap.size !== sources.length) fail("clones", "", "incomplete tokenizer output");
  const inspected = inputs.map((input) => ({
    path: input.path,
    tokens: counts.get(input.path) ?? fail("clones", input.path, "missing tokenizer count"),
    format: input.format,
  }));
  const clusters = new Map<string, Cluster>();
  const normalization: { evidence: number; exactSpans: number; eligibleSpans: number }[] = [];
  for (const [index, clone] of raw.entries()) {
    const spans = [clone.duplicationA, clone.duplicationB].map((duplicate) => {
      const source = sources.find((s) => s.path === duplicate.sourceId);
      if (!source) fail("clones", duplicate.sourceId, "engine returned uninventoried source");
      const tokens = (
        tokenMap.get(source.path) ?? fail("clones", source.path, "missing tokens")
      ).filter((t) => t.format === clone.format);
      const start = tokens.findIndex((t) => t.range[0] >= duplicate.range[0]);
      const after = tokens.findIndex((t) => t.range[1] > duplicate.range[1]);
      if (start < 0) fail("clones", source.path, "engine range contains no tokens");
      return { source, tokens, start, end: after < 0 ? tokens.length : after };
    });
    const first = spans[0],
      second = spans[1];
    if (!first || !second) fail("clones", "", "missing engine pair");
    const exact = equalSpans(first, second, settings.minTokens);
    const eligible = exact.filter((span) =>
      span.occurrences.every((o) => o.endLine - o.startLine >= settings.minLines),
    );
    normalization.push({
      evidence: index,
      exactSpans: exact.length,
      eligibleSpans: eligible.length,
    });
    retainClusters(eligible, index);
  }
  function retainClusters(eligible: ReturnType<typeof equalSpans>, index: number): void {
    for (const { tokenHash, tokenCount, occurrences } of eligible) {
      const cluster = clusters.get(tokenHash) ?? {
        id: "",
        partition: [],
        tokenHash,
        tokenCount,
        settingsHash,
        occurrences: [],
        evidence: [],
      };
      for (const occurrence of occurrences)
        if (!cluster.occurrences.some((o) => key(o) === key(occurrence)))
          cluster.occurrences.push(occurrence);
      if (!cluster.evidence.includes(index)) cluster.evidence.push(index);
      clusters.set(tokenHash, cluster);
    }
  }

  const maximal = [...clusters.values()].filter(
    (cluster) =>
      ![...clusters.values()].some(
        (other) =>
          other !== cluster &&
          other.tokenCount > cluster.tokenCount &&
          cluster.occurrences.every((o) =>
            other.occurrences.some(
              (p) => p.path === o.path && p.start <= o.start && p.end >= o.end,
            ),
          ),
      ),
  );
  for (const cluster of maximal) {
    cluster.occurrences.sort((a, b) => (key(a) < key(b) ? -1 : Number(key(a) > key(b))));
    cluster.partition = [
      ...(cluster.occurrences.some((o) => ["production", "tooling"].includes(o.category))
        ? ["production"]
        : []),
      ...(cluster.occurrences.some((o) => ["test", "fixture", "benchmark"].includes(o.category))
        ? ["test"]
        : []),
      ...(cluster.occurrences.some((o) => o.category === "historical") ? ["historical"] : []),
    ];
    cluster.id = sha(
      JSON.stringify({
        tokenHash: cluster.tokenHash,
        occurrences: cluster.occurrences.map((o) => [o.path, o.start, o.end]),
      }),
    );
  }
  maximal.sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
  return {
    settings,
    settingsHash,
    inspected,
    clusters: maximal,
    rawEvidence: raw,
    normalization,
    production: maximal.filter((c) => c.partition.includes("production")).length,
    test: maximal.filter((c) => c.partition.includes("test")).length,
  };
}
