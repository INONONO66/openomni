import { describe, expect, test } from "bun:test";
import { WorkItem } from "./index.js";

const validCompletionReport = {
  summary: "Implemented the requested schema delta.",
  claims: [
    {
      statement: "Focused protocol checks passed.",
      evidenceIds: ["ev_protocol"],
    },
  ],
  caveats: ["Runtime verification remains separate."],
  followUps: ["Verify current consumers."],
};

const validReadBackCheck = {
  kind: "url_fetch" as const,
  target: "https://example.com/post",
  passed: true,
  observedAt: 2,
  statusCode: 200,
  matchedText: "published headline",
};

describe("WorkItem retained contracts", () => {
  test("parses every executor kind and rejects unknown kinds", () => {
    const executorKinds = [
      "internal_chat_agent",
      "connector_endpoint",
      "external_api",
      "a2a",
      "human_channel",
    ] as const;

    for (const executorKind of executorKinds) {
      expect(WorkItem.ExecutorKind.parse(executorKind)).toBe(executorKind);
    }

    expect(WorkItem.ExecutorKind.safeParse("spreadsheet_macro").success).toBe(false);
  });

  test("parses completion reports and applies collection defaults", () => {
    const report = WorkItem.CompletionReport.parse({
      summary: validCompletionReport.summary,
      claims: validCompletionReport.claims,
    });

    expect(report).toEqual({
      summary: validCompletionReport.summary,
      claims: validCompletionReport.claims,
      caveats: [],
      followUps: [],
    });
  });

  test("rejects incomplete completion reports", () => {
    const invalidReports = [
      { ...validCompletionReport, summary: "" },
      { ...validCompletionReport, claims: [] },
      { ...validCompletionReport, caveats: [""] },
      { ...validCompletionReport, followUps: [""] },
      {
        ...validCompletionReport,
        claims: [{ statement: "", evidenceIds: ["ev_protocol"] }],
      },
      {
        ...validCompletionReport,
        claims: [{ statement: "Checks passed.", evidenceIds: [] }],
      },
      {
        ...validCompletionReport,
        claims: [{ statement: "Checks passed.", evidenceIds: [""] }],
      },
    ];

    for (const report of invalidReports) {
      expect(WorkItem.CompletionReport.safeParse(report).success).toBe(false);
    }
  });

  test("parses read-back request variants and envelope defaults", () => {
    expect(
      WorkItem.ReadBackRequest.parse({
        kind: "url_fetch",
        target: "https://example.com/post",
      }),
    ).toEqual({
      kind: "url_fetch",
      target: "https://example.com/post",
      maxBodyBytes: 1_000_000,
    });

    expect(
      WorkItem.ReadBackRequest.parse({
        kind: "api_query",
        target: "https://api.example.com/items/1",
      }),
    ).toMatchObject({ kind: "api_query", method: "GET", maxBodyBytes: 1_000_000 });

    expect(
      WorkItem.ReadBackRequest.parse({
        kind: "citation_match",
        target: "https://example.com/source",
        quotedText: "source sentence",
      }),
    ).toMatchObject({ kind: "citation_match", quotedText: "source sentence" });

    expect(
      WorkItem.ReadBackRequestEnvelope.parse({
        claimIndex: 0,
        request: {
          kind: "url_fetch",
          target: "https://example.com/post",
        },
      }),
    ).toMatchObject({ claimIndex: 0, request: { kind: "url_fetch" } });
  });

  test("rejects unsafe or malformed read-back requests", () => {
    for (const target of [
      "not a url",
      "ftp://example.com/post",
      "file:///tmp/post",
      "javascript:alert(1)",
    ]) {
      expect(
        WorkItem.ReadBackRequest.safeParse({
          kind: "url_fetch",
          target,
        }).success,
      ).toBe(false);
    }

    for (const request of [
      { kind: "url_fetch", target: "https://example.com", timeoutMs: 0 },
      { kind: "url_fetch", target: "https://example.com", maxBodyBytes: -1 },
      { kind: "api_query", target: "https://example.com", method: "POST" },
      { kind: "citation_match", target: "https://example.com", quotedText: "" },
    ]) {
      expect(WorkItem.ReadBackRequest.safeParse(request).success).toBe(false);
    }

    expect(
      WorkItem.ReadBackRequestEnvelope.safeParse({
        claimIndex: -1,
        request: { kind: "url_fetch", target: "https://example.com" },
      }).success,
    ).toBe(false);
  });

  test("parses read-back check variants", () => {
    expect(WorkItem.ReadBackCheck.parse(validReadBackCheck)).toMatchObject({
      kind: "url_fetch",
      passed: true,
    });

    expect(
      WorkItem.ReadBackCheck.parse({
        kind: "api_query",
        target: "calendar:event/123",
        passed: true,
        observedAt: 3,
        statusCode: 200,
        responseDigest: "sha256:abc123",
      }),
    ).toMatchObject({ kind: "api_query", method: "GET" });

    expect(
      WorkItem.ReadBackCheck.parse({
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "source sentence",
        matchedText: "source sentence",
      }),
    ).toMatchObject({ kind: "citation_match", quotedText: "source sentence" });
  });

  test("rejects inconsistent successful read-back checks", () => {
    for (const check of [
      { ...validReadBackCheck, statusCode: 404 },
      {
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "source sentence",
      },
      {
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "",
        matchedText: "source sentence",
      },
    ]) {
      expect(WorkItem.ReadBackCheck.safeParse(check).success).toBe(false);
    }
  });

  test("requires evidence and read-back results to agree", () => {
    expect(
      WorkItem.Evidence.parse({
        id: "ev_read_back",
        kind: "verification",
        description: "Fetched the published URL.",
        passed: true,
        createdAt: 4,
        readBack: validReadBackCheck,
      }),
    ).toMatchObject({ id: "ev_read_back", passed: true });

    expect(
      WorkItem.Evidence.safeParse({
        id: "ev_read_back",
        kind: "verification",
        description: "Fetched the published URL.",
        passed: false,
        createdAt: 4,
        readBack: validReadBackCheck,
      }).success,
    ).toBe(false);
  });
});
