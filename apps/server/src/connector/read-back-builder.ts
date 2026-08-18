import { type AppConnector, WorkItem } from "@openomni/protocol";
import type { ConnectorTemplateValues } from "./env.js";

interface BuildInput {
  readonly connector: AppConnector.Definition;
  readonly output: string | undefined;
  readonly values: ConnectorTemplateValues;
}

type BuildResult = { readonly ok: true; readonly output: string | undefined } | BuildFailure;

interface BuildFailure {
  readonly ok: false;
  readonly error: string;
}

type OutputObject = Record<string, unknown>;

const tokenPattern = /\{\{(prompt|worktree|runId|sessionId|output(?:\.[A-Za-z0-9_-]+)*)\}\}/g;

export function applyConnectorReadBackBuilders(input: BuildInput): BuildResult {
  const builders = input.connector.evidence.completionReport?.readBackRequests ?? [];
  if (builders.length === 0) return { ok: true, output: input.output };
  if (input.output === undefined) {
    return { ok: false, error: "connector read-back builder requires completion output" };
  }

  const parsed = parseOutputObject(input.output);
  if (!parsed.ok) return parsed;

  const requests: WorkItem.ReadBackRequestEnvelope[] = [];
  for (const [index, builder] of builders.entries()) {
    const rendered = renderReadBackBuilder(builder, input.values, input.output, parsed.output);
    if (!rendered.ok) {
      return { ok: false, error: `connector read-back builder ${index} failed: ${rendered.error}` };
    }
    requests.push(rendered.request);
  }

  const existing = existingReadBackRequests(parsed.output);
  return {
    ok: true,
    output: JSON.stringify({
      ...parsed.output,
      readBackRequests: [...existing, ...requests],
    }),
  };
}

function parseOutputObject(
  output: string,
): { readonly ok: true; readonly output: OutputObject } | BuildFailure {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "connector read-back builder requires JSON object output" };
    }
    return { ok: true, output: parsed as OutputObject };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      ok: false,
      error: "connector read-back builder requires JSON completion envelope output",
    };
  }
}

function existingReadBackRequests(output: OutputObject): WorkItem.ReadBackRequestEnvelope[] {
  if (!Array.isArray(output.readBackRequests)) return [];
  return output.readBackRequests.map((request) => WorkItem.ReadBackRequestEnvelope.parse(request));
}

function renderReadBackBuilder(
  builder: NonNullable<AppConnector.ReportSource["readBackRequests"]>[number],
  values: ConnectorTemplateValues,
  rawOutput: string,
  output: OutputObject,
): { readonly ok: true; readonly request: WorkItem.ReadBackRequestEnvelope } | BuildFailure {
  const target = renderTemplate(builder.request.target, values, rawOutput, output);
  if (!target.ok) return target;

  const base = {
    claimIndex: builder.claimIndex,
    criterionIndex: builder.criterionIndex,
    request: {
      kind: builder.request.kind,
      target: target.value,
      ...(builder.request.timeoutMs === undefined ? {} : { timeoutMs: builder.request.timeoutMs }),
      ...(builder.request.maxBodyBytes === undefined
        ? {}
        : { maxBodyBytes: builder.request.maxBodyBytes }),
    },
  };

  switch (builder.request.kind) {
    case "url_fetch":
      return { ok: true, request: WorkItem.ReadBackRequestEnvelope.parse(base) };
    case "api_query":
      return {
        ok: true,
        request: WorkItem.ReadBackRequestEnvelope.parse({
          ...base,
          request: {
            ...base.request,
            ...(builder.request.method === undefined ? {} : { method: builder.request.method }),
          },
        }),
      };
    case "citation_match": {
      const quotedText = renderTemplate(builder.request.quotedText, values, rawOutput, output);
      if (!quotedText.ok) return quotedText;
      return {
        ok: true,
        request: WorkItem.ReadBackRequestEnvelope.parse({
          ...base,
          request: { ...base.request, quotedText: quotedText.value },
        }),
      };
    }
  }
}

function renderTemplate(
  template: string,
  values: ConnectorTemplateValues,
  rawOutput: string,
  output: OutputObject,
): { readonly ok: true; readonly value: string } | BuildFailure {
  let error: string | undefined;
  const value = template.replace(tokenPattern, (_match, key: string) => {
    const resolved = resolveTemplateValue(key, values, rawOutput, output);
    if (!resolved.ok) {
      error = resolved.error;
      return "";
    }
    return resolved.value;
  });
  if (error !== undefined) return { ok: false, error };
  if (value.includes("{{") || value.includes("}}")) {
    return { ok: false, error: `unsupported template token in: ${template}` };
  }
  return { ok: true, value };
}

function resolveTemplateValue(
  key: string,
  values: ConnectorTemplateValues,
  rawOutput: string,
  output: OutputObject,
): { readonly ok: true; readonly value: string } | BuildFailure {
  switch (key) {
    case "prompt":
      return { ok: true, value: values.prompt };
    case "worktree":
      return { ok: true, value: values.worktree };
    case "runId":
      return { ok: true, value: values.runId };
    case "sessionId":
      return { ok: true, value: values.sessionId };
    case "output":
      return { ok: true, value: rawOutput };
    default:
      return resolveOutputPath(key, output);
  }
}

function resolveOutputPath(
  key: string,
  output: OutputObject,
): { readonly ok: true; readonly value: string } | BuildFailure {
  if (!key.startsWith("output.")) {
    return { ok: false, error: `unsupported template key: ${key}` };
  }
  let value: unknown = output;
  for (const segment of key.slice("output.".length).split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `missing output field: ${key}` };
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (value === undefined || value === null) {
    return { ok: false, error: `missing output field: ${key}` };
  }
  if (typeof value === "string") return { ok: true, value };
  if (typeof value === "number" || typeof value === "boolean") {
    return { ok: true, value: String(value) };
  }
  return { ok: false, error: `output field is not scalar: ${key}` };
}
