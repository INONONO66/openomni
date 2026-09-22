import { expect, test } from "bun:test";
import { Effect, Either } from "effect";
import ts from "typescript";
import * as Agent from "../packages/agent/src/errors";
import * as Channels from "../packages/channels/src/errors";
import * as Code from "../packages/codemode/src/errors";
import * as Ipc from "../packages/ipc/src/errors";
import * as Ledger from "../packages/ledger/src/errors";
import * as Llm from "../packages/llm/src/errors";
import * as Machines from "../packages/machines/src/errors";

const diagnostic = { operation: "fixture", cause: "foreign diagnostic" };
const message = { message: "fixture" };
const usage = { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const llm = {
  ForeignFailure: new Llm.ForeignFailure(diagnostic),
  APIError: new Llm.APIError({ ...message, isRetryable: true, statusCode: 429 }),
  LlmRunFailure: new Llm.LlmRunFailure({ ...message, usage, aborted: false, contextOverflow: false, visibleOutput: true }),
  ModelResolutionError: new Llm.ModelResolutionError({ ...message, provider: "provider", model: "model", reason: "model_not_found" }),
  AuthInvalidFileError: new Llm.AuthInvalidFileError({ ...message, path: "auth.json" }),
  AuthResolutionError: new Llm.AuthResolutionError({ ...message, provider: "provider", reason: "missing_auth" }),
  ProxyModelsError: new Llm.ProxyModelsError({ ...message, url: "https://fixture.invalid" }),
  TransportFailure: new Llm.TransportFailure({ ...diagnostic, ...message }),
  InvalidProviderData: new Llm.InvalidProviderData({ ...diagnostic, ...message }),
} satisfies { [K in Llm.LlmError["_tag"]]: Extract<Llm.LlmError, { _tag: K }> };
const ipc = {
  ForeignFailure: new Ipc.ForeignFailure(diagnostic),
  IpcConnectionError: new Ipc.IpcConnectionError(message),
  IpcProtocolError: new Ipc.IpcProtocolError(message),
  IpcTimeoutError: new Ipc.IpcTimeoutError({ ...message, requestId: "request", method: "fixture" }),
  IpcRemoteError: new Ipc.IpcRemoteError({ ...message, requestId: "request", method: "fixture", code: 1000 }),
} satisfies { [K in Ipc.IpcError["_tag"]]: Extract<Ipc.IpcError, { _tag: K }> };
const machines = {
  ForeignFailure: new Machines.ForeignFailure(diagnostic),
  MachineCellError: new Machines.MachineCellError({ ...message, cellId: "cell", code: "unknown_cell_id" }),
  MachineRefusalError: new Machines.MachineRefusalError({ ...message, reason: "closed" }),
  SpawnFailure: new Machines.SpawnFailure({ ...diagnostic, ...message }),
  FilesystemFailure: new Machines.FilesystemFailure({ ...diagnostic, ...message }),
  TransportFailure: new Machines.TransportFailure({ ...diagnostic, ...message }),
} satisfies { [K in Machines.MachineError["_tag"]]: Extract<Machines.MachineError, { _tag: K }> };
const code = {
  ForeignFailure: new Code.ForeignFailure(diagnostic),
  CodemodeError: new Code.CodemodeError({ ...message, reason: "closed" }),
  DriverFailure: new Code.DriverFailure({ ...diagnostic, ...message }),
} satisfies { [K in Code.CodeError["_tag"]]: Extract<Code.CodeError, { _tag: K }> };
const ledger = {
  ForeignFailure: new Ledger.ForeignFailure(diagnostic),
  SessionNotFound: new Ledger.SessionNotFound({ sessionId: "session" }),
  MaterializeRefused: new Ledger.MaterializeRefused({ sessionId: "session", reason: "input" }),
  LeaseRefused: new Ledger.LeaseRefused({ sessionId: "session", reason: "held", holder: "holder", fence: 1, expiresAt: 1 }),
  CommitRefused: new Ledger.CommitRefused({ sessionId: "session", reason: "fence", fence: 1, currentFence: 2, expectedRevision: 0, currentRevision: 1 }),
  InboxCommitRefused: new Ledger.InboxCommitRefused({ sessionId: "session", inboxId: "inbox", reason: "identity" }),
  AlarmRefused: new Ledger.AlarmRefused({ alarmId: "alarm", operation: "arm", reason: "session" }),
  StorageUnavailable: new Ledger.StorageUnavailable({ capability: "storage" }),
  CorruptRecord: new Ledger.CorruptRecord({ operation: "decode", id: "record" }),
} satisfies { [K in Ledger.LedgerError["_tag"]]: Extract<Ledger.LedgerError, { _tag: K }> };
// Agent.SessionError absorbs Ledger.LedgerError and Llm.LlmRunFailure, so those fixtures are members too.
const agent = {
  ...ledger,
  LlmRunFailure: llm.LlmRunFailure,
  ForeignFailure: new Agent.ForeignFailure(diagnostic),
  PolicyDenied: new Agent.PolicyDenied({ phase: "pre", ruleIds: [] }),
  ToolBodyFailed: new Agent.ToolBodyFailed({ tool: "fixture", cause: "foreign" }),
  Interrupted: new Agent.Interrupted(),
  CommitFailed: new Agent.CommitFailed({ error: ledger.CommitRefused }),
  OutcomeUnknown: new Agent.OutcomeUnknown({ reason: "unsettled" }),
  SessionMissing: new Agent.SessionMissing({ sessionId: "session" }),
  LeaseLost: new Agent.LeaseLost({ sessionId: "session", fence: 1 }),
  GenerationUnavailable: new Agent.GenerationUnavailable({ generation: 1 }),
  ExecutionApprovalError: new Agent.ExecutionApprovalError({ code: "stale_approval" }),
  AgentStopError: new Agent.AgentStopError({ reason: "budget" }),
} satisfies { [K in Agent.SessionError["_tag"]]: Extract<Agent.SessionError, { _tag: K }> };
const channels = {
  ForeignFailure: new Channels.ForeignFailure(diagnostic),
  InvalidInbound: new Channels.InvalidInbound({ operation: "frame", reason: "invalid_json" }),
  DiscordGatewayFetchError: new Channels.DiscordGatewayFetchError(message),
  DiscordApiError: new Channels.DiscordApiError(message),
  DiscordHandlerMissingError: new Channels.DiscordHandlerMissingError(message),
  SlackApiError: new Channels.SlackApiError(message),
  SlackHandlerMissingError: new Channels.SlackHandlerMissingError(message),
  SlackEndpointKeyError: new Channels.SlackEndpointKeyError(message),
  TelegramApiError: new Channels.TelegramApiError(message),
  IngressRoutingError: new Channels.IngressRoutingError("route_blocked", "fixture", { traceId: "trace", time: 1, inboundId: "inbound", surface: "ws", mode: "direct", reason: "fixture", factsUsed: [], stage: "blacklist", outcome: "drop" }),
  SendAdmissionConflict: new Channels.SendAdmissionConflict(message),
  RateLimited: new Channels.RateLimited({ ...message, status: 429, attempts: 1, responseHeaders: {}, responseBody: "" }),
} satisfies { [K in Channels.ChannelError["_tag"]]: Extract<Channels.ChannelError, { _tag: K }> };

const packages = [
  { name: "agent", module: Agent, union: "SessionError", failures: agent },
  { name: "channels", module: Channels, union: "ChannelError", failures: channels },
  { name: "codemode", module: Code, union: "CodeError", failures: code },
  { name: "ipc", module: Ipc, union: "IpcError", failures: ipc },
  { name: "ledger", module: Ledger, union: "LedgerError", failures: ledger },
  { name: "llm", module: Llm, union: "LlmError", failures: llm },
  { name: "machines", module: Machines, union: "MachineError", failures: machines },
] as const;

for (const entry of packages) {
  test(`${entry.name}: every failure export is tagged, yieldable and covered by the package union`, () => {
    const constructors = Object.values(entry.module).filter((value) => typeof value === "function" && value.prototype instanceof Error);
    const failures = Object.values(entry.failures);
    const owned = new Set(failures.map((failure) => failure.constructor));
    for (const ctor of constructors) expect(owned.has(ctor)).toBe(true);
    const foreign = packages.filter((other) => other !== entry).flatMap((other) => Object.values(other.module));
    for (const ctor of owned) expect(constructors.includes(ctor) || foreign.includes(ctor)).toBe(true);
    for (const failure of failures) {
      expect(Effect.isEffect(failure)).toBe(true);
      const caught = Effect.runSync(Effect.either(Effect.fail(failure)));
      expect(Either.isLeft(caught) && caught.left === failure).toBe(true);
      expect("data" in failure).toBe(false);
    }
    const cause: string = entry.failures.ForeignFailure.cause;
    expect(cause).toBe(diagnostic.cause);
    expect(JSON.parse(JSON.stringify(entry.failures.ForeignFailure))).toMatchObject({ _tag: "ForeignFailure", ...diagnostic });
  });
}

test("every package union has a compiling exhaustive tag switch and string foreign cause", () => {
  const fixturePath = new URL("./effect-error-exhaustiveness.fixture.ts", import.meta.url).pathname;
  const fixture = packages.map((entry, index) => `
    import type { ${entry.union} as Union${index}, ForeignFailure as Foreign${index} } from "../packages/${entry.name}/src/errors";
    function exhaustive${index}(error: Union${index}): string {
      switch (error._tag) {
        ${Object.keys(entry.failures).map((tag) => `case ${JSON.stringify(tag)}: return error._tag;`).join("\n")}
        default: { const absent: never = error; return absent; }
      }
    }
    const cause${index} = (error: Foreign${index}): string => error.cause;
  `).join("\n");
  const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: ["bun"] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === fixturePath
    ? ts.createSourceFile(file, fixture, languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fixturePath], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))).toEqual([]);
}, 15_000);
