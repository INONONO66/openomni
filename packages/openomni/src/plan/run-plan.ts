import type { AgentBudget } from "@openomni/agent";
import { NamedError, Plan, type Storage, type Tool, type TraceContext } from "@openomni/protocol";
import { z } from "zod";
import { memoryPlanAdapter } from "./memory-plan-adapter.js";
import { PlanAgent } from "./plan-agent.js";

const PLAN_VALIDATION_FAILED = "PLAN_VALIDATION_FAILED";

export const PlanValidationFailedError = NamedError.create(
  PLAN_VALIDATION_FAILED,
  z.object({
    code: z.literal(PLAN_VALIDATION_FAILED),
    message: z.string(),
    issues: z.array(z.string()),
  }),
);

interface StoredPlanDocument {
  readonly content: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface MarkdownPlanStep {
  readonly stepId: string;
  readonly description: string;
  readonly expectedOutput: string;
  readonly dependsOn: string[];
}

const dependencySeparators = /\s*(?:,|\band\b)\s*/i;

function extractJsonCandidate(content: string): unknown | undefined {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = fenced ? [trimmed, fenced] : [trimmed];

  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // intentionally swallow parse failures to try the next candidate
    }
  }

  return undefined;
}

function sectionName(line: string): string | undefined {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!match) return undefined;
  return match[1]?.trim().toLowerCase();
}

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/[`*_]/g, "")
    .replace(/^\[|\]$/g, "")
    .replace(/^\(|\)$/g, "")
    .trim();
}

function normalizeStepId(value: string): string {
  return stripMarkdownSyntax(value)
    .replace(/^step\s+/i, "")
    .replace(/[.:;,-]+$/g, "")
    .trim();
}

function splitDependencies(value: string): string[] {
  return value
    .split(dependencySeparators)
    .map((dep) => normalizeStepId(dep))
    .filter(Boolean);
}

function readListItem(line: string): string | undefined {
  return line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/)?.[1]?.trim();
}

function parseStepLine(line: string, index: number): MarkdownPlanStep | undefined {
  const item = readListItem(line);
  if (!item) return undefined;

  const dependencyMatch = item.match(
    /\s+[[(]?depends\s+on\s*:?\s*([^\])]+)[\])]?$|\s+[[(]?deps\s*:?\s*([^\])]+)[\])]?$/i,
  );
  const dependsOn = splitDependencies(dependencyMatch?.[1] ?? dependencyMatch?.[2] ?? "");
  const withoutDependencies = dependencyMatch ? item.slice(0, dependencyMatch.index).trim() : item;

  const explicit = withoutDependencies.match(/^(?:\[([^\]]+)\]|([^:–—-]{1,80}))\s*[:–—-]\s+(.+)$/);
  const stepId = explicit ? normalizeStepId(explicit[1] ?? explicit[2] ?? "") : `step-${index + 1}`;
  const description = stripMarkdownSyntax(explicit?.[3] ?? withoutDependencies);

  if (!description) return undefined;

  return {
    stepId,
    description,
    expectedOutput: description,
    dependsOn,
  };
}

function parseDependencyLine(line: string): { stepId: string; dependsOn: string[] } | undefined {
  const item = readListItem(line) ?? line.trim();
  const match = item.match(/^(.+?)\s+depends\s+on\s+(.+)$/i) ?? item.match(/^(.+?)\s*:\s*(.+)$/);
  if (!match) return undefined;

  const stepId = normalizeStepId(match[1] ?? "");
  const dependsOn = splitDependencies(match[2] ?? "");
  if (!stepId || dependsOn.length === 0) return undefined;
  return { stepId, dependsOn };
}

function parseGoalLine(line: string): string | undefined {
  return line.match(/^\s*(?:[-*+]\s*)?goal\s*:\s*(.+)$/i)?.[1]?.trim();
}

function parseMarkdownPlan(planId: string, fallbackGoal: string, doc: StoredPlanDocument): unknown {
  const lines = doc.content.split(/\r?\n/);
  const steps: MarkdownPlanStep[] = [];
  const dependencyMap = new Map<string, string[]>();
  const goalLines: string[] = [];
  let section: string | undefined;

  for (const line of lines) {
    const nextSection = sectionName(line);
    if (nextSection) {
      section = nextSection;
      continue;
    }

    const inlineGoal = parseGoalLine(line);
    if (inlineGoal) goalLines.push(stripMarkdownSyntax(inlineGoal));

    if (section?.includes("goal") && line.trim()) goalLines.push(stripMarkdownSyntax(line));

    if (section?.includes("depend")) {
      const dependency = parseDependencyLine(line);
      if (dependency) dependencyMap.set(dependency.stepId, dependency.dependsOn);
      continue;
    }

    if (section === undefined || section.includes("step")) {
      const step = parseStepLine(line, steps.length);
      if (step) steps.push(step);
    }
  }

  return {
    planId,
    goal: goalLines.find(Boolean) ?? fallbackGoal,
    steps: steps.map((step) => ({
      ...step,
      dependsOn: dependencyMap.get(step.stepId) ?? step.dependsOn,
    })),
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

function parseStoredPlan(planId: string, goal: string, doc: StoredPlanDocument): unknown {
  return extractJsonCandidate(doc.content) ?? parseMarkdownPlan(planId, goal, doc);
}

function validateStoredPlan(planId: string, goal: string, doc: StoredPlanDocument): void {
  const result = Plan.Schema.safeParse(parseStoredPlan(planId, goal, doc));
  if (result.success) return;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });

  throw new PlanValidationFailedError(
    {
      code: PLAN_VALIDATION_FAILED,
      message: `plan validation failed: ${issues.join("; ")}`,
      issues,
    },
    { cause: result.error },
  );
}

export interface RunPlanConfig {
  model: { provider: string; id: string };
  systemPrompt?: string;
  planSubAdapter?: Storage.PlanSubAdapter;
  planId?: string;
  budget?: AgentBudget;
  tools?: Tool.Spec[];
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  traceContext?: TraceContext.Type;
}

export async function runPlan(goal: string, config: RunPlanConfig): Promise<Plan.Result> {
  const planId = config.planId ?? crypto.randomUUID();
  const planSubAdapter = config.planSubAdapter ?? memoryPlanAdapter();

  const prompt = config.systemPrompt?.includes("{{PLAN_ID}}")
    ? config.systemPrompt.replace("{{PLAN_ID}}", planId)
    : config.systemPrompt;

  const agent = PlanAgent.create({
    model: config.model,
    systemPrompt: prompt,
    planSubAdapter,
    budget: config.budget,
    tools: config.tools,
    toolExecutor: config.toolExecutor,
  });

  await agent.run({
    messages: [{ role: "user", content: goal }],
    traceContext: config.traceContext,
  });

  const doc = await planSubAdapter.read(planId);
  if (!doc) throw new Error(`plan agent did not write plan: ${planId}`);
  validateStoredPlan(planId, goal, doc);
  return { planId };
}
