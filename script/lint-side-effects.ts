type SideEffectRuleId = "processor-projected-sink" | "session-mutation-publish-after-write";

interface SideEffectViolation {
  readonly ruleId: SideEffectRuleId;
  readonly filePath: string;
  readonly line: number;
  readonly message: string;
}

interface SideEffectRule {
  readonly ruleId: SideEffectRuleId;
  readonly filePath: string;
  readonly sideEffect: RegExp;
  readonly requiredBefore: readonly string[];
  readonly requiredAfter: readonly string[];
  readonly scopeStart?: RegExp;
  readonly scopeEnd?: RegExp;
  readonly message: string;
}

interface SourceMatch {
  readonly index: number;
  readonly text: string;
}

const hotFiles = ["packages/llm/src/processor/index.ts", "packages/ledger/src/session/messages.ts"];

const rules: readonly SideEffectRule[] = [
  {
    ruleId: "processor-projected-sink",
    filePath: "packages/llm/src/processor/index.ts",
    sideEffect: /\bsink\.on(?:Message|ToolCall|ToolResult|Snapshot)\(/g,
    requiredBefore: [
      "const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);",
    ],
    requiredAfter: [],
    message: "processor sink side effects must flow through createProjectedSink",
  },
  {
    ruleId: "session-mutation-publish-after-write",
    filePath: "packages/ledger/src/session/messages.ts",
    sideEffect: /adapter\.message\.set\(sessionID, message\)/g,
    scopeStart: /export function addMessage\(/g,
    scopeEnd: /\nexport function /g,
    requiredBefore: [],
    requiredAfter: ["Storage.publishObservation(Event.Updated, { info: updated })"],
    message: "Session.addMessage must publish Event.Updated after adapter.message.set",
  },
  {
    ruleId: "session-mutation-publish-after-write",
    filePath: "packages/ledger/src/session/messages.ts",
    sideEffect: /adapter\.session\.set\(sessionID, updated\)/g,
    scopeStart: /export function addMessage\(/g,
    scopeEnd: /\nexport function /g,
    requiredBefore: [],
    requiredAfter: ["Storage.publishObservation(Event.Updated, { info: updated })"],
    message: "Session.addMessage must publish Event.Updated after adapter.session.set",
  },
  {
    ruleId: "session-mutation-publish-after-write",
    filePath: "packages/ledger/src/session/messages.ts",
    sideEffect: /adapter\.part\.set\(messageID, part\)/g,
    scopeStart: /export function addPart\(/g,
    scopeEnd: /\nexport function /g,
    requiredBefore: [],
    requiredAfter: ["Storage.publishObservation(Event.Updated, { info:"],
    message: "Session.addPart must publish Event.Updated after adapter.part.set",
  },
];

async function main(): Promise<void> {
  const violations: SideEffectViolation[] = [];

  await verifyHotFilesExist();
  for (const filePath of hotFiles) {
    const source = await Bun.file(filePath).text();
    violations.push(...validateSideEffectRules(filePath, source));
  }

  if (violations.length === 0) {
    process.stdout.write(`OK: side-effect lint scanned ${hotFiles.length} hot files\n`);
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `VIOLATION: ${violation.filePath}:${violation.line} [${violation.ruleId}] — ${violation.message}\n`,
    );
  }

  process.exit(1);
}

async function verifyHotFilesExist(): Promise<void> {
  for (const filePath of hotFiles) {
    if (!(await Bun.file(filePath).exists())) {
      throw new Error(`Missing hot file: ${filePath}`);
    }
  }
}

export function validateSideEffectRules(
  filePath: string,
  source: string,
): SideEffectViolation[] {
  return rules
    .filter((rule) => rule.filePath === filePath)
    .flatMap((rule) => validateRule(rule, source));
}

function validateRule(rule: SideEffectRule, source: string): SideEffectViolation[] {
  const sideEffects = matches(source, rule.sideEffect);

  if (sideEffects.length === 0) {
    return [
      {
        ruleId: rule.ruleId,
        filePath: rule.filePath,
        line: 1,
        message: `side-effect call pattern not found for rule: ${rule.message}`,
      },
    ];
  }

  return sideEffects.flatMap((sideEffect) => {
    const searchStart = rule.scopeStart
      ? lastMatchStartBefore(source, rule.scopeStart, sideEffect.index)
      : 0;
    const prefix = source.slice(searchStart, sideEffect.index);
    const missingBefore = rule.requiredBefore.filter((snippet) => !prefix.includes(snippet));

    const scopeEnd = firstMatchStartAfter(source, rule.scopeEnd, sideEffect.index);
    const suffix = source.slice(
      sideEffect.index + sideEffect.text.length,
      scopeEnd === -1 ? source.length : scopeEnd,
    );
    const missingAfter = rule.requiredAfter.filter((snippet) => !suffix.includes(snippet));

    const missing = [...missingBefore, ...missingAfter];

    if (missing.length === 0) {
      return [];
    }

    return [
      {
        ruleId: rule.ruleId,
        filePath: rule.filePath,
        line: lineNumberForOffset(source, sideEffect.index),
        message: `${rule.message}; missing: ${missing.join(", ")}`,
      },
    ];
  });
}

function firstMatchStartAfter(source: string, pattern: RegExp | undefined, offset: number): number {
  if (!pattern) return source.indexOf("\n  }", offset);
  return (
    matches(source, pattern)
      .map((match) => match.index)
      .find((index) => index > offset) ?? -1
  );
}

function matches(source: string, pattern: RegExp): SourceMatch[] {
  pattern.lastIndex = 0;
  const results: SourceMatch[] = [];

  let match = pattern.exec(source);
  while (match !== null) {
    results.push({ index: match.index, text: match[0] });
    match = pattern.exec(source);
  }

  return results;
}

function lastMatchStartBefore(source: string, pattern: RegExp, offset: number): number {
  const starts = matches(source, pattern)
    .map((match) => match.index)
    .filter((index) => index <= offset);
  return starts.at(-1) ?? 0;
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  });
}
