import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { compareCoverage, parseLcovSummary } from "../../../../script/check-coverage-ratchet";

const baseline = JSON.parse(readFileSync("script/conformance/coverage-baseline.json", "utf8"));
const final = readFileSync(".omo/evidence/pr980/coverage-r2/final-agent.lcov.info", "utf8");
const prior = readFileSync(".omo/evidence/pr980/coverage-r2/review-baseline.lcov.info", "utf8");
const native = parseLcovSummary(final);
const previous = parseLcovSummary(prior);
assert.equal(previous.linesFound, 5055);
assert.equal(previous.linesHit, 4855);
assert.equal(baseline["packages/agent"].pct, 98.2);

function lines(text: string) {
  const found = new Map<string, Map<number, number>>();
  for (const record of text.split("end_of_record")) {
    const source = record.match(/^SF:(src\/.*)$/m)?.[1];
    if (source === undefined) continue;
    found.set(source, new Map([...record.matchAll(/^DA:(\d+),(\d+)/gm)]
      .map((match) => [Number(match[1]), Number(match[2])])));
  }
  return found;
}
const before = lines(prior);
const after = lines(final);
assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
let frozenFound = 0;
let frozenHit = 0;
const omitted: { source: string; line: number }[] = [];
const gained: Record<string, number[]> = {};
for (const [source, records] of before) {
  const current = after.get(source);
  assert.ok(current);
  for (const [line, hits] of records) {
    frozenFound += 1;
    if ((current.get(line) ?? 0) > 0) frozenHit += 1;
    if (!current.has(line)) omitted.push({ source, line });
    if (hits === 0 && (current.get(line) ?? 0) > 0) (gained[source] ??= []).push(line);
  }
}
const frozen = {
  linesFound: frozenFound,
  linesHit: frozenHit,
  pct: Math.round(frozenHit / frozenFound * 10000) / 100,
};
for (const [name, coverage] of Object.entries({ native, frozen })) {
  const comparison = compareCoverage(
    { "packages/agent": baseline["packages/agent"] },
    { "packages/agent": coverage },
    0.5,
  );
  assert.deepEqual(comparison.violations, []);
  assert.ok(coverage.linesHit / coverage.linesFound * 100 > 97.7);
  console.log(JSON.stringify({ name, ...coverage, exactPct: coverage.linesHit / coverage.linesFound * 100, comparison }));
}
console.log(JSON.stringify({ omitted, gained, sourceRecords: after.size }, null, 2));
