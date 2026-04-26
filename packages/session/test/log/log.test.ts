import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Log, TraceContext } from "../../src/index";

describe("Log", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let capturedOutput: string[];

  beforeEach(() => {
    capturedOutput = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      capturedOutput.push(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    delete process.env.OPENOMNI_LOG_LEVEL;
    delete process.env.OPENOMNI_PROCESS;
  });

  it("outputs JSON-parseable log lines", () => {
    Log.info("test message");
    expect(capturedOutput.length).toBe(1);
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.msg).toBe("test message");
    expect(parsed.level).toBe("info");
  });

  it("includes ts, pid, component fields", () => {
    process.env.OPENOMNI_PROCESS = "test-worker";
    Log.info("test");
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed).toHaveProperty("ts");
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.ts > 0).toBe(true);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.component).toBe("test-worker");
  });

  it("includes context fields in output", () => {
    Log.info("test", { userId: "123", action: "login" });
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.userId).toBe("123");
    expect(parsed.action).toBe("login");
  });

  it("respects OPENOMNI_LOG_LEVEL=debug", () => {
    process.env.OPENOMNI_LOG_LEVEL = "debug";
    Log.debug("debug msg");
    Log.info("info msg");
    expect(capturedOutput.length).toBe(2);
  });

  it("filters debug when OPENOMNI_LOG_LEVEL=info", () => {
    process.env.OPENOMNI_LOG_LEVEL = "info";
    Log.debug("debug msg");
    Log.info("info msg");
    expect(capturedOutput.length).toBe(1);
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.msg).toBe("info msg");
  });

  it("filters debug and info when OPENOMNI_LOG_LEVEL=warn", () => {
    process.env.OPENOMNI_LOG_LEVEL = "warn";
    Log.debug("debug msg");
    Log.info("info msg");
    Log.warn("warn msg");
    expect(capturedOutput.length).toBe(1);
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.level).toBe("warn");
  });

  it("outputs all levels when OPENOMNI_LOG_LEVEL=debug", () => {
    process.env.OPENOMNI_LOG_LEVEL = "debug";
    Log.debug("d");
    Log.info("i");
    Log.warn("w");
    Log.error("e");
    expect(capturedOutput.length).toBe(4);
  });

  it("defaults to info level when env not set", () => {
    delete process.env.OPENOMNI_LOG_LEVEL;
    Log.debug("debug");
    Log.info("info");
    expect(capturedOutput.length).toBe(1);
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.level).toBe("info");
  });

  it("defaults component to 'unknown' when OPENOMNI_PROCESS not set", () => {
    delete process.env.OPENOMNI_PROCESS;
    Log.info("test");
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.component).toBe("unknown");
  });

  it("supports all log levels", () => {
    process.env.OPENOMNI_LOG_LEVEL = "debug";
    Log.debug("debug");
    Log.info("info");
    Log.warn("warn");
    Log.error("error");
    expect(capturedOutput.length).toBe(4);
    const levels = capturedOutput.map((line) => JSON.parse(line).level);
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });

  it("withContext merges context into all log calls", () => {
    const logger = Log.withContext({ traceId: "abc123", userId: "user1" });
    logger.info("test message");
    expect(capturedOutput.length).toBe(1);
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.traceId).toBe("abc123");
    expect(parsed.userId).toBe("user1");
    expect(parsed.msg).toBe("test message");
  });

  it("withContext allows overriding context in individual calls", () => {
    const logger = Log.withContext({ traceId: "abc123", userId: "user1" });
    logger.info("test", { userId: "user2" });
    const parsed = JSON.parse(capturedOutput[0]);
    expect(parsed.traceId).toBe("abc123");
    expect(parsed.userId).toBe("user2");
  });

  it("withContext works with all log levels", () => {
    process.env.OPENOMNI_LOG_LEVEL = "debug";
    const logger = Log.withContext({ traceId: "xyz789" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(capturedOutput.length).toBe(4);
    const parsed = capturedOutput.map((line) => JSON.parse(line));
    expect(parsed.every((p) => p.traceId === "xyz789")).toBe(true);
  });
});

describe("TraceContext", () => {
  it("create generates a traceId", () => {
    const ctx = TraceContext.create();
    expect(ctx.traceId).toBeDefined();
    expect(typeof ctx.traceId).toBe("string");
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });

  it("create with overrides merges fields", () => {
    const ctx = TraceContext.create({ sessionId: "sess123", userId: "user1" });
    expect(ctx.traceId).toBeDefined();
    expect(ctx.sessionId).toBe("sess123");
  });

  it("child preserves parent traceId by default", () => {
    const parent = TraceContext.create({ sessionId: "sess123" });
    const child = TraceContext.child(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.sessionId).toBe(parent.sessionId);
  });

  it("child can override parent fields", () => {
    const parent = TraceContext.create({ sessionId: "sess123" });
    const child = TraceContext.child(parent, { runId: "run456" });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.sessionId).toBe(parent.sessionId);
    expect(child.runId).toBe("run456");
  });

  it("empty generates a new traceId", () => {
    const ctx = TraceContext.empty();
    expect(ctx.traceId).toBeDefined();
    expect(typeof ctx.traceId).toBe("string");
  });

  it("empty generates unique traceIds", () => {
    const ctx1 = TraceContext.empty();
    const ctx2 = TraceContext.empty();
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });
});
