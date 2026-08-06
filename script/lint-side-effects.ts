type SideEffectRuleId =
  | "tool-ledger-before-execute"
  | "mcp-ledger-before-execute"
  | "processor-projected-sink"
  | "ingress-ledger-before-session-write"
  | "session-mutation-ledger-before-storage-write";

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
  readonly requiredInScope?: readonly string[];
  readonly scopeStart?: RegExp;
  readonly scopeEnd?: RegExp;
  readonly message: string;
}

interface SourceMatch {
  readonly index: number;
  readonly text: string;
}

const hotFiles = [
  "packages/openomni/src/execution-runtime/tool/executor.ts",
  "packages/openomni/src/execution-runtime/tool/executor-events.ts",
  "apps/server/src/tool/mcp/provider-execution.ts",
  "packages/llm/src/processor/index.ts",
  "packages/openomni/src/ingress/event-projector.ts",
  "packages/openomni/src/ingress/session-bridge.ts",
  "packages/session/src/session/messages.ts",
];

const rules: readonly SideEffectRule[] = [
  {
    ruleId: "tool-ledger-before-execute",
    filePath: "packages/openomni/src/execution-runtime/tool/executor.ts",
    sideEffect:
      /tool\.execute\(dispatchedCall(?:, (?:\{ signal: linkedAbort\.signal \}|executionContext))?\)/g,
    scopeStart:
      /return async \(call: Tool\.Call(?:, context\?: ToolExecutionContext)?\): Promise<Tool\.Result> => \{/g,
    requiredBefore: ["publishToolStarted({", "toolCallId: call.id", "toolName: originalName"],
    message: "tool.execute must be preceded by a before-side-effect audit publish",
  },
  {
    ruleId: "tool-ledger-before-execute",
    filePath: "packages/openomni/src/execution-runtime/tool/executor-events.ts",
    sideEffect: /export function publishToolStarted\(args: \{/g,
    requiredBefore: [],
    requiredInScope: [
      "Bus.publish(ToolExecution.Started, {",
      "toolCallId: args.toolCallId",
      "toolName: args.toolName",
    ],
    message: "publishToolStarted must append the tool execution started ledger event",
  },
  {
    ruleId: "mcp-ledger-before-execute",
    filePath: "apps/server/src/tool/mcp/provider-execution.ts",
    sideEffect:
      /tool\.execute\(\{ \.\.\.call, tool: tool\.spec\.name \}(?:, (?:context|executionContext))?\)/g,
    scopeStart:
      /export async function executeMcpTool\(input: ExecuteMcpToolInput\): Promise<Tool\.Result> \{/g,
    requiredBefore: ["Bus.publish(PolicyEvent.ActionRequested, {", "actionId", "tool.spec.name"],
    message: "MCP tool execution must be preceded by a mandatory action_requested ledger append",
  },
  {
    ruleId: "processor-projected-sink",
    filePath: "packages/llm/src/processor/index.ts",
    sideEffect: /\bsink\.on(?:Message|ToolCall|ToolResult|Snapshot)\(/g,
    requiredBefore: [
      "const sink = createProjectedSink(configuredSink, sessionID, trace?.traceId);",
    ],
    message: "processor sink side effects must flow through createProjectedSink",
  },
  {
    ruleId: "ingress-ledger-before-session-write",
    filePath: "packages/openomni/src/ingress/event-projector.ts",
    sideEffect: /Session\.addMessage\(sessionId, message\)/g,
    scopeStart: /export function project\(/g,
    requiredBefore: ["audit.append(", '"ingress.inbound.message.write"'],
    message:
      "projected inbound messages must append ingress.inbound.message.write before Session.addMessage",
  },
  {
    ruleId: "ingress-ledger-before-session-write",
    filePath: "packages/openomni/src/ingress/event-projector.ts",
    sideEffect: /Session\.addPart\(message\.id, part\)/g,
    scopeStart: /export function project\(/g,
    requiredBefore: ["audit.append(", '"ingress.inbound.part.write"'],
    message:
      "projected inbound parts must append ingress.inbound.part.write before Session.addPart",
  },
  {
    ruleId: "ingress-ledger-before-session-write",
    filePath: "packages/openomni/src/ingress/session-bridge.ts",
    sideEffect: /Session\.addMessage\(sessionId, message\)/g,
    scopeStart: /export function store(?:Plan|Direct)Result\(/g,
    requiredBefore: ["audit.append(", '"ingress.writeback.message.write"'],
    message:
      "session bridge writebacks must append ingress.writeback.message.write before Session.addMessage",
  },
  {
    ruleId: "ingress-ledger-before-session-write",
    filePath: "packages/openomni/src/ingress/session-bridge.ts",
    sideEffect: /Session\.addPart\(message\.id, part\)/g,
    scopeStart: /export function store(?:Plan|Direct)Result\(/g,
    requiredBefore: ["audit.append(", '"ingress.writeback.part.write"'],
    message:
      "session bridge writebacks must append ingress.writeback.part.write before Session.addPart",
  },
  {
    ruleId: "session-mutation-ledger-before-storage-write",
    filePath: "packages/session/src/session/messages.ts",
    sideEffect: /adapter\.message\.set\(sessionID, message\)/g,
    scopeStart: /export function addMessage\(/g,
    scopeEnd: /\nexport function /g,
    requiredBefore: [],
    requiredInScope: ["Bus.publish(Event.Updated, { info: updated })"],
    message: "Session.addMessage must publish Event.Updated after adapter.message.set",
  },
  {
    ruleId: "session-mutation-ledger-before-storage-write",
    filePath: "packages/session/src/session/messages.ts",
    sideEffect: /adapter\.session\.set\(sessionID, updated\)/g,
    scopeStart: /export function addMessage\(/g,
    scopeEnd: /\nexport function /g,
    requiredBefore: [],
    requiredInScope: ["Bus.publish(Event.Updated, { info: updated })"],
    message: "Session.addMessage must publish Event.Updated after adapter.session.set",
  },
  {
    ruleId: "session-mutation-ledger-before-storage-write",
    filePath: "packages/session/src/session/messages.ts",
    sideEffect: /adapter\.part\.set\(messageID, part\)/g,
    scopeStart: /export function addPart\(/g,
    scopeEnd: /\nexport function /g,
    requiredBefore: [],
    requiredInScope: ["Bus.publish(Event.Updated, { info:"],
    message: "Session.addPart must publish Event.Updated after adapter.part.set",
  },
];

async function main(): Promise<void> {
  const violations: SideEffectViolation[] = [];

  await verifyHotFilesExist();
  for (const filePath of hotFiles) {
    const source = await Bun.file(filePath).text();
    const fileRules = rules.filter((rule) => rule.filePath === filePath);

    for (const rule of fileRules) {
      violations.push(...validateRule(rule, source));
    }
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
    const scope = source.slice(searchStart, scopeEnd > 0 ? scopeEnd : source.length);
    const missingInScope = (rule.requiredInScope || []).filter(
      (snippet) => !scope.includes(snippet),
    );

    const missing = [...missingBefore, ...missingInScope];

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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
});
