# OmO State Management Architecture Analysis

**Date**: May 2026  
**Project**: oh-my-openagent (OmO)  
**Scope**: Category system, delegation chain, session state, tool permissions, wisdom accumulation, stall detection, model-personality matching

---

## EXECUTIVE SUMMARY

OmO implements a **category-driven delegation system** that routes tasks to specialized models based on domain classification, not explicit model selection. The architecture uses **session lineage tracking** to maintain parent→child agent relationships, **persistent background task state** to enable stall detection and recovery, and **model-specific prompt builders** to adapt orchestration behavior to each model's strengths.

Key insight: **OmO makes "dumb models" perform better through structural guidance** — category-specific prompts, tool restrictions, and explicit delegation rules that constrain the model's decision space.

---

## 1. CATEGORY SYSTEM: Task Classification & Routing

### 1.1 Category Definition & Resolution

**Location**: `src/tools/delegate-task/`

Categories are **domain-specific task classifiers** that map to optimized models and prompt appends:

```typescript
// src/tools/delegate-task/builtin-categories.ts
const BUILTIN_CATEGORIES: BuiltinCategoryDefinition[] = [
  ...GOOGLE_CATEGORIES,
  ...OPENAI_CATEGORIES,
  ...ANTHROPIC_CATEGORIES,
  ...KIMI_CATEGORIES,
]

export const DEFAULT_CATEGORIES: Record<string, CategoryConfig> = buildCategoryRecord(
  (definition) => definition.config
)

export const CATEGORY_PROMPT_APPENDS: Record<string, string> = buildCategoryRecord(
  (definition) => definition.promptAppend
)
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/delegate-task/builtin-categories.ts

### 1.2 Built-in Categories (OpenAI Example)

**Location**: `src/tools/delegate-task/openai-categories.ts`

```typescript
export const OPENAI_CATEGORIES: BuiltinCategoryDefinition[] = [
  {
    name: "ultrabrain",
    config: { model: "openai/gpt-5.5", variant: "xhigh" },
    description: "Use ONLY for genuinely hard, logic-heavy tasks. Give clear goals only, not step-by-step instructions.",
    promptAppend: ULTRABRAIN_CATEGORY_PROMPT_APPEND,
  },
  {
    name: "deep",
    config: { model: "openai/gpt-5.5", variant: "medium" },
    description: "Goal-oriented autonomous problem-solving on hairy problems requiring deep research.",
    promptAppend: DEEP_CATEGORY_PROMPT_APPEND,
    resolvePromptAppend: resolveDeepCategoryPromptAppend,  // Model-specific variant
  },
  {
    name: "quick",
    config: { model: "openai/gpt-5.4-mini" },
    description: "Trivial tasks - single file changes, typo fixes, simple modifications",
    promptAppend: QUICK_CATEGORY_PROMPT_APPEND,
  },
]
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/delegate-task/openai-categories.ts#L196-L216

### 1.3 Category Resolution Pipeline

**Location**: `src/tools/delegate-task/category-resolver.ts`

The resolver implements a **model-aware fallback chain**:

```typescript
export async function resolveCategoryExecution(
  args: DelegateTaskArgs,
  executorCtx: ExecutorContext,
  inheritedModel: string | undefined,
  systemDefaultModel: string | undefined
): Promise<CategoryResolutionResult> {
  const { client, userCategories, sisyphusJuniorModel } = executorCtx

  // 1. Validate category exists
  const categoryName = args.category!
  const enabledCategories = mergeCategories(userCategories)
  const categoryExists = enabledCategories[categoryName] !== undefined

  // 2. Resolve category config (merges defaults + user overrides)
  const resolved = resolveCategoryConfig(categoryName, {
    userCategories,
    inheritedModel,
    systemDefaultModel,
    availableModels,
  })

  // 3. Model resolution with fallback chain
  const requirement = CATEGORY_MODEL_REQUIREMENTS[args.category!]
  const normalizedConfiguredFallbackModels = normalizeFallbackModels(resolved.config.fallback_models)
  
  // Precedence: explicit category model > sisyphus-junior default > category resolved model
  actualModel = explicitCategoryModel ?? overrideModel ?? resolved.model
  
  // 4. Apply category parameters (temperature, top_p, maxTokens, reasoning_effort)
  categoryModel = applyCategoryParams({ ...parsedModel, variant: variantToUse }, resolved.config)
  
  // 5. Resolve dynamic prompt append (model-specific)
  const categoryPromptAppend = resolveCategoryPromptAppendForModel(
    categoryName,
    actualModel,
    staticPromptAppend,
    userPromptAppend
  )
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/delegate-task/category-resolver.ts#L59-L127

### 1.4 Category State Persistence

Categories are **stateless at runtime** but **configurable per-session**:

```typescript
// src/tools/delegate-task/categories.ts
export interface ResolveCategoryConfigOptions {
  userCategories?: CategoriesConfig
  inheritedModel?: string
  systemDefaultModel?: string
  availableModels?: Set<string>
}

export interface ResolveCategoryConfigResult {
  config: CategoryConfig
  promptAppend: string
  model: string | undefined
  isUserConfiguredModel: boolean
}
```

**Key insight**: Categories are **resolved at delegation time**, not stored. The system computes the optimal model + prompt for each category based on:
- User config overrides
- Available models
- Category requirements
- Parent session's model context

---

## 2. AGENT DELEGATION CHAIN: Parent→Child Tracking

### 2.1 Session Lineage & Parent Tracking

**Location**: `src/hooks/atlas/boulder-session-lineage.ts`

OmO tracks **parent→child session relationships** to maintain delegation context:

```typescript
export async function isSessionInBoulderLineage(input: {
  client: PluginInput["client"]
  sessionID: string
  boulderSessionIDs: string[]
}): Promise<boolean> {
  const visitedSessionIDs = new Set<string>()
  let currentSessionID = input.sessionID

  // Walk up the parent chain
  while (!visitedSessionIDs.has(currentSessionID)) {
    visitedSessionIDs.add(currentSessionID)

    const sessionResult = await input.client.session
      .get({ path: { id: currentSessionID } })

    if (!sessionResult || sessionResult.error) {
      return false
    }

    const parentSessionID = sessionResult.data?.parentID
    if (!parentSessionID) {
      return false
    }

    // Check if this parent is in the boulder lineage
    if (input.boulderSessionIDs.includes(parentSessionID)) {
      return true
    }

    currentSessionID = parentSessionID
  }

  return false
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/atlas/boulder-session-lineage.ts

### 2.2 Background Task State & Delegation Tracking

**Location**: `src/features/background-agent/types.ts`

Each delegated task maintains **rich metadata** for tracking and recovery:

```typescript
export interface BackgroundTask {
  id: string
  sessionId?: string                    // Subagent's session
  rootSessionId?: string                // Top-level session
  parentSessionId: string               // Caller's session
  parentMessageId: string               // Message that triggered delegation
  teamRunId?: string                    // Team mode tracking
  
  description: string
  prompt: string
  agent: string                         // Which agent (explore, oracle, etc.)
  spawnDepth?: number                   // Nesting depth
  
  status: BackgroundTaskStatus          // pending | running | completed | error | cancelled | interrupt
  queuedAt?: Date
  startedAt?: Date
  completedAt?: Date
  result?: string
  error?: string
  
  progress?: TaskProgress               // Tool call tracking for stall detection
  parentModel?: { providerID: string; modelID: string }
  model?: DelegatedModelConfig          // Resolved model for this task
  fallbackChain?: FallbackEntry[]       // Retry chain on model errors
  attemptCount?: number                 // Number of fallback retries
  
  concurrencyKey?: string               // Active concurrency slot
  concurrencyGroup?: string             // Persistent key for resume
  
  parentAgent?: string                  // Parent's agent name
  parentTools?: Record<string, boolean> // Parent's tool restrictions
  isUnstableAgent?: boolean             // Marked as unstable
  category?: string                     // Category used (e.g., 'quick', 'deep')
  
  retryNotification?: {
    previousSessionID?: string
    failedModel?: string
    failedError?: string
    nextModel: string
  }
  
  attempts?: BackgroundTaskAttempt[]    // Structured attempt history
  currentAttemptID?: string             // Currently active attempt
  
  lastMsgCount?: number                 // For stability detection
  stablePolls?: number                  // Consecutive stable polls
  consecutiveMissedPolls?: number       // For timeout detection
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/background-agent/types.ts#L44-L99

### 2.3 Delegation Result Passing

**Location**: `src/features/background-agent/manager.ts`

Results flow back through the parent session via **system reminders**:

```typescript
// Pseudo-code from manager polling loop
if (task.status === "completed") {
  // Emit system reminder to parent session with result
  await emitSystemReminder(parentSessionId, {
    type: "background_task_completed",
    taskId: task.id,
    result: task.result,
    agent: task.agent,
  })
  
  // Mark task as processed
  await tryCompleteTask(task, "polling")
}
```

**Key insight**: Delegation is **asynchronous and fire-and-forget** by default. The parent session polls for completion and receives results via system reminders, not direct return values.

---

## 3. SESSION STATE MANAGEMENT

### 3.1 Session-Level State Tracking

**Location**: `src/hooks/atlas/types.ts`

Each session maintains **execution state** for continuation and recovery:

```typescript
export interface SessionState {
  lastEventWasAbortError?: boolean
  skipNextIdleAfterRuntimeErrorRetry?: boolean
  lastContinuationInjectedAt?: number
  isInjectingContinuation?: boolean
  
  promptFailureCount: number            // Tracks prompt failures
  lastFailureAt?: Date
  pendingRetryTimer?: ReturnType<typeof setTimeout>
  
  waitingForFinalWaveApproval?: boolean
  pendingFinalWaveTaskCount?: number
  approvedFinalWaveTaskCount?: number
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/atlas/types.ts#L39-L50

### 3.2 Context Injection System

**Location**: `src/features/context-injector/types.ts`

OmO maintains a **context registry** that injects relevant information into each turn:

```typescript
export type ContextSourceType =
  | "keyword-detector"
  | "rules-injector"
  | "directory-agents"
  | "directory-readme"
  | "custom"

export interface ContextEntry {
  id: string
  source: ContextSourceType
  content: string
  priority: ContextPriority              // critical | high | normal | low
  registrationOrder: number
  metadata?: Record<string, unknown>
}

export interface PendingContext {
  merged: string                         // Merged context string
  entries: ContextEntry[]
  hasContent: boolean
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/context-injector/types.ts

**Key insight**: Context is **dynamically registered and merged** per-turn, not statically baked into prompts. This enables:
- Conditional context injection based on task type
- Priority-based ordering (critical context first)
- Deduplication across sources

---

## 4. TOOL PERMISSION STATE

### 4.1 Agent-Level Tool Restrictions

**Location**: `src/shared/agent-tool-restrictions.ts`

Each agent has a **denylist of tools** it cannot access:

```typescript
const AGENT_RESTRICTIONS: Record<string, Record<string, boolean>> = {
  explore: {
    write: false,
    edit: false,
    task: false,
    call_omo_agent: false,
  },

  librarian: {
    write: false,
    edit: false,
    task: false,
    call_omo_agent: false,
  },

  oracle: {
    write: false,
    edit: false,
    task: false,
    call_omo_agent: false,
  },

  metis: {
    write: false,
    edit: false,
  },

  momus: {
    write: false,
    edit: false,
  },

  "multimodal-looker": {
    read: true,  // Read-only
  },

  "sisyphus-junior": {
    task: false,
  },
}

export function getAgentToolRestrictions(agentName: string): Record<string, boolean> {
  const stripped = stripInvisibleAgentCharacters(agentName)
  const agentRestrictions = AGENT_RESTRICTIONS[stripped] ?? {}

  return {
    ...TEAM_TOOL_DENYLIST,
    ...agentRestrictions,
  }
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/shared/agent-tool-restrictions.ts

### 4.2 Permission Schema

**Location**: `src/config/schema/internal/permission.ts`

Permissions are **three-valued** (ask, allow, deny):

```typescript
export const PermissionValueSchema = z.enum(["ask", "allow", "deny"])
export type PermissionValue = z.infer<typeof PermissionValueSchema>

export const AgentPermissionSchema = z.object({
  edit: PermissionValueSchema.optional(),
  bash: BashPermissionSchema.optional(),
  webfetch: PermissionValueSchema.optional(),
  task: PermissionValueSchema.optional(),
  doom_loop: PermissionValueSchema.optional(),
  external_directory: PermissionValueSchema.optional(),
})
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/config/schema/internal/permission.ts

**Key insight**: Tool restrictions are **enforced at the SDK level** (session.prompt `tools` parameter), not in the agent prompt. This prevents agents from even attempting forbidden tools.

---

## 5. WISDOM ACCUMULATION & CONTEXT PERSISTENCE

### 5.1 Context Injection Architecture

OmO doesn't have explicit "wisdom accumulation" but achieves similar effects through **context injection**:

**Location**: `src/features/context-injector/`

```typescript
// Collector gathers context from multiple sources
export interface ContextEntry {
  id: string
  source: ContextSourceType
  content: string
  priority: ContextPriority
  registrationOrder: number
  metadata?: Record<string, unknown>
}

// Injector merges and injects into session
export interface PendingContext {
  merged: string
  entries: ContextEntry[]
  hasContent: boolean
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/context-injector/types.ts

### 5.2 Session-Scoped Knowledge

Knowledge is accumulated **per-session** through:

1. **AGENTS.md files** — Auto-generated hierarchical context
2. **Directory-specific context** — Injected based on file path
3. **Keyword detection** — Triggers context injection based on message content
4. **Rules injector** — Custom context rules per project

**Key insight**: OmO doesn't persist knowledge across sessions. Instead, it **injects relevant context at the start of each session** based on:
- Project structure (AGENTS.md)
- Task domain (keyword detection)
- User rules (custom injectors)

This is **stateless wisdom** — the knowledge lives in files, not in session state.

---

## 6. STALL DETECTION & RECOVERY

### 6.1 Idle Event Handling

**Location**: `src/features/background-agent/session-idle-event-handler.ts`

OmO detects stalls through **session.idle events** and validates actual progress:

```typescript
export function handleSessionIdleBackgroundEvent(args: {
  properties: Record<string, unknown>
  findBySession: (sessionID: string) => BackgroundTask | undefined
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  validateSessionHasOutput: (sessionID: string) => Promise<boolean>
  checkSessionTodos: (sessionID: string) => Promise<boolean>
  tryCompleteTask: (task: BackgroundTask, source: string) => Promise<boolean>
  emitIdleEvent: (sessionID: string) => void
}): void {
  const sessionID = getString(properties, "sessionID")
  const task = findBySession(sessionID)
  
  if (!task || task.status !== "running") return

  const startedAt = task.startedAt
  const elapsedMs = Date.now() - startedAt.getTime()
  
  // 1. Defer early idles (MIN_IDLE_TIME_MS = 30 seconds)
  if (elapsedMs < MIN_IDLE_TIME_MS) {
    const remainingMs = MIN_IDLE_TIME_MS - elapsedMs
    const timer = setTimeout(() => {
      idleDeferralTimers.delete(task.id)
      emitIdleEvent(sessionID)
    }, remainingMs)
    idleDeferralTimers.set(task.id, timer)
    return
  }

  // 2. Validate session has actual output
  validateSessionHasOutput(sessionID)
    .then(async (hasValidOutput) => {
      if (!hasValidOutput) {
        log("[background-agent] Session.idle but no valid output yet, waiting")
        return
      }

      // 3. Check for incomplete todos
      const hasIncompleteTodos = await checkSessionTodos(sessionID)
      if (hasIncompleteTodos) {
        log("[background-agent] Task has incomplete todos, waiting for todo-continuation")
        return
      }

      // 4. Complete task if all checks pass
      await tryCompleteTask(task, "session.idle event")
    })
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/background-agent/session-idle-event-handler.ts

### 6.2 Progress Tracking

**Location**: `src/features/background-agent/types.ts`

Each task tracks **tool call patterns** for loop detection:

```typescript
export interface TaskProgress {
  toolCalls: number
  lastTool?: string
  toolCallWindow?: ToolCallWindow              // Consecutive tool call tracking
  countedToolPartIDs?: Set<string>
  lastUpdate: Date
  lastMessage?: string
  lastMessageAt?: Date
}

export interface ToolCallWindow {
  lastSignature: string
  consecutiveCount: number
  threshold: number
}
```

**Key insight**: Stall detection is **multi-layered**:
1. **Time-based**: MIN_IDLE_TIME_MS (30 seconds) before considering idle
2. **Output-based**: Validates session has actual message output
3. **Todo-based**: Checks for incomplete todos (prevents premature completion)
4. **Tool-based**: Tracks consecutive tool calls to detect loops

---

## 7. MODEL-PERSONALITY MATCHING

### 7.1 Model Detection & Routing

**Location**: `src/agents/types.ts`

OmO detects model families and routes to **model-specific prompt builders**:

```typescript
export function isGptModel(model: string): boolean {
  const modelName = extractModelName(model).toLowerCase()
  return modelName.includes("gpt")
}

export function isGpt5_5Model(model: string): boolean {
  const modelName = extractModelName(model).toLowerCase()
  return modelName.includes("gpt-5.5") || modelName.includes("gpt-5-5")
}

export function isGpt5_3CodexModel(model: string): boolean {
  const modelName = extractModelName(model).toLowerCase()
  return modelName.includes("gpt-5.3-codex") || modelName.includes("gpt-5-3-codex")
}

export function isClaudeOpus47Model(model: string): boolean {
  const modelName = extractModelName(model).toLowerCase().replaceAll(".", "-")
  return modelName.includes("claude-opus-4-7")
}

export function isKimiK2Model(model: string): boolean {
  const modelName = extractModelName(model).toLowerCase()
  if (modelName.includes("kimi")) return true
  if (/k2[-.]?p[56]/.test(modelName)) return true
  return false
}

export function isGeminiModel(model: string): boolean {
  if (GEMINI_PROVIDERS.some((prefix) => model.startsWith(prefix))) return true
  const modelName = extractModelName(model).toLowerCase()
  return modelName.startsWith("gemini-")
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/types.ts#L73-L149

### 7.2 Model-Specific Prompt Builders

**Location**: `src/agents/sisyphus/`

Each model family gets a **specialized Sisyphus prompt**:

```typescript
// src/agents/sisyphus.ts
function buildDynamicSisyphusPrompt(
  model: string,
  availableAgents: AvailableAgent[],
  availableTools: AvailableTool[] = [],
  availableSkills: AvailableSkill[] = [],
  availableCategories: AvailableCategory[] = [],
  useTaskSystem = false,
): string {
  // Model-specific routing
  if (isGptNativeSisyphusModel(model)) {
    return buildGpt55SisyphusPrompt(...)
  }
  if (isClaudeOpus47Model(model)) {
    return buildClaudeOpus47SisyphusPrompt(...)
  }
  if (isKimiK2Model(model)) {
    return buildKimiK26SisyphusPrompt(...)
  }
  if (isGeminiModel(model)) {
    return buildGeminiToolMandate(...) + buildGeminiDelegationOverride(...) + ...
  }
  
  // Default fallback
  return buildDefaultSisyphusPrompt(...)
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus.ts#L57-L64

### 7.3 Model-Specific Category Prompts

**Location**: `src/tools/delegate-task/openai-categories.ts`

Categories also have **model-specific prompt variants**:

```typescript
export function resolveDeepCategoryPromptAppend(model: string | undefined): string {
  if (model && isGpt5_3CodexModel(model)) {
    return DEEP_CATEGORY_PROMPT_APPEND_GPT_5_3_CODEX
  }
  if (model && isGpt5_5Model(model)) {
    return DEEP_CATEGORY_PROMPT_APPEND_GPT_5_5
  }
  return DEEP_CATEGORY_PROMPT_APPEND
}
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/delegate-task/openai-categories.ts#L135-L143

### 7.4 Example: GPT-5.5 Deep Category Prompt

The prompt is **tuned to GPT-5.5's strengths**:

```markdown
# How deep mode adjusts the base behavior

**Exploration budget: generous.** Read the files you need, trace dependencies both directions, 
fire 2-5 explore/librarian sub-agents in parallel for broader questions. Build a complete mental 
model before the first `apply_patch`. Exploration here is an investment, not overhead.

**Goal, not plan.** You receive a GOAL describing the desired outcome. You figure out HOW to 
achieve it. The orchestrator deliberately did not hand you a step-by-step plan; producing one 
and asking for approval is not what was asked. Execute.

**Root cause bias.** Prefer root-cause fixes over symptom fixes. A null check around `foo()` 
is a symptom fix; fixing whatever causes `foo()` to return unexpected values is the root fix. 
Trace at least two levels up before settling on an answer.

**Completion bar: full delivery.** "Simplified version", "proof of concept", and "you can 
extend this later" are not acceptable deliveries for a deep task. The orchestrator routed here 
specifically for a complete solution.
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/delegate-task/openai-categories.ts#L113-L133

**Key insight**: OmO **adapts its orchestration behavior to each model's capabilities**:
- **GPT-5.5**: Emphasizes exploration, root-cause analysis, complete solutions
- **GPT-5.3-Codex**: Emphasizes autonomy, persistence, no approval-seeking
- **Claude Opus 4.7**: Different delegation table, different tool guidance
- **Kimi K2.6**: Different prompt structure, different reasoning patterns
- **Gemini**: Special tool mandate, schema guards, call examples

This is **not** just different models doing the same task. It's **different orchestration strategies** for different model families.

---

## 8. STRUCTURAL GUIDANCE: How OmO Makes Dumb Models Better

### 8.1 Constraint-Based Routing

Instead of asking the model "what should I do?", OmO **constrains the decision space**:

```typescript
// Category system: "You are working on [domain] tasks"
// Tool restrictions: "You cannot use [tools]"
// Delegation rules: "Delegate [work] to [agent]"
// Intent gate: "Classify this as [type] and route to [handler]"
```

### 8.2 Explicit Delegation Rules

**Location**: `src/agents/sisyphus/gpt-5-5.ts`

```markdown
## Delegation philosophy

Delegation is not an escape hatch; it is how you scale. Every delegation decision follows the same logic:

- If a specialist agent (oracle, metis, momus, librarian, explore) perfectly matches the request, 
  invoke that agent directly via task(subagent_type=...).
- If no specialist matches but a category does (visual-engineering, ultrabrain, deep, quick, writing), 
  delegate via task(category=..., load_skills=[...]). Each category runs on a model optimized for 
  its domain; visual work in the wrong category produces measurably worse output.
- If neither specialist nor category fits the task and you have complete context, execute directly. 
  This should be rare.

The default bias is to delegate. You work yourself only when the task is demonstrably simple and local.
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus/gpt-5-5.ts#L184-L192

### 8.3 Intent Gate (Phase 0)

**Location**: `src/agents/sisyphus/gpt-5-5.ts`

Before any action, the model **classifies intent** and announces routing:

```markdown
### Surface to true intent

| What the user says | What they probably want | Your routing |
|---|---|---|
| "explain X", "how does Y work" | Understanding, not changes | Explore, synthesize, answer in prose |
| "implement X", "add Y", "create Z" | Code changes | Plan, delegate, verify |
| "look into X", "check Y", "investigate" | Investigation, not fixes | Explore, report findings, wait |
| "what do you think about X?" | Evaluation before committing | Evaluate, propose, wait for go-ahead |
| "X is broken", "seeing error Y" | Minimal fix at root cause | Diagnose, fix minimally, verify |
| "refactor", "improve", "clean up" | Open-ended change, needs scoping | Assess codebase, propose approach, wait |
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus/gpt-5-5.ts#L110-L119

### 8.4 Context-Completion Gate

**Location**: `src/agents/sisyphus/gpt-5-5.ts`

The model **cannot implement** without explicit authorization:

```markdown
### Context-completion gate

You may implement only when all three conditions hold:

1. The current message contains an explicit implementation verb (implement, add, create, fix, change, write, build).
2. Scope and objective are concrete enough to execute without guessing.
3. No blocking specialist result is pending that your work depends on. Oracle consultations in 
   particular must complete before you implement code they were asked to design.

If any condition fails, you research or clarify instead and end your response. 
Do not invent authorization you were not given.
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus/gpt-5-5.ts#L135-L143

### 8.5 Parallelization Mandate

**Location**: `src/agents/sisyphus/gpt-5-5.ts`

```markdown
## Parallelize aggressively

Independent tool calls run in the same response, never sequentially. This is the dominant lever 
on speed and accuracy. If you are about to issue a tool call and another independent call could 
go out at the same time, batch them. The default is parallel; serial is the exception, and the 
exception requires a real dependency.

- Reads, searches, and diagnostics: fire all at once. Reading 5 files in one response beats 
  reading them one at a time.
- Background sub-agents: fire 2-5 explore/librarian in the same response with run_in_background=true.
- Multiple delegations to disjoint write targets: dispatch concurrently when their files do not overlap.
- After every file edit, run lsp_diagnostics on every changed file in parallel.
```

**Evidence**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus/gpt-5-5.ts#L68-L77

---

## 9. DATA STRUCTURES SUMMARY

### 9.1 Core State Objects

| Object | Location | Purpose |
|--------|----------|---------|
| `BackgroundTask` | `src/features/background-agent/types.ts` | Tracks delegated work: status, model, fallback chain, progress |
| `SessionState` | `src/hooks/atlas/types.ts` | Per-session execution state: failures, continuation, approval gates |
| `TaskProgress` | `src/features/background-agent/types.ts` | Tool call tracking for stall detection |
| `ContextEntry` | `src/features/context-injector/types.ts` | Registered context with priority and source |
| `CategoryConfig` | `src/config/schema/` | Category definition: model, temperature, prompt append |
| `AgentPermission` | `src/config/schema/internal/permission.ts` | Three-valued permissions: ask, allow, deny |

### 9.2 State Persistence

| State | Persistence | Scope |
|-------|-----------|-------|
| **Category config** | Stateless (computed at delegation time) | Per-delegation |
| **Session lineage** | Session API (parentID) | Per-session |
| **Background tasks** | In-memory map + polling | Per-background-task |
| **Tool restrictions** | Hardcoded + config | Per-agent |
| **Context entries** | In-memory registry | Per-session |
| **Session state** | In-memory map (Atlas hook) | Per-session |

---

## 10. KEY INSIGHTS FOR OPENOMNI

### 10.1 What OmO Does Well

1. **Category-driven routing** — Tasks are classified by domain, not explicitly assigned to models
2. **Model-aware prompts** — Each model family gets specialized orchestration instructions
3. **Constraint-based guidance** — Tool restrictions, delegation rules, and intent gates constrain the model's decision space
4. **Stall detection** — Multi-layered (time, output, todo, tool-based) prevents stuck agents
5. **Session lineage** — Parent→child tracking enables context propagation and result passing
6. **Fallback chains** — Automatic retry on model errors with configurable fallback models

### 10.2 What OmO Doesn't Have (Relevant to OpenOmni)

1. **Persistent wisdom** — Knowledge doesn't accumulate across sessions; context is injected per-session
2. **Explicit state machines** — No formal state machine for agent lifecycle (pending → running → completed)
3. **Specification-first design** — No upfront specification phase (Ouroboros-style)
4. **Quality gates** — No multi-stage evaluation or quality scoring
5. **Workspace isolation** — No per-workspace state isolation (Symphony-style)

### 10.3 Architectural Patterns to Adopt

1. **Category system** — Implement domain-specific task classification
2. **Model-specific prompts** — Build orchestration behavior that adapts to model capabilities
3. **Constraint-based routing** — Use tool restrictions and delegation rules to guide models
4. **Session lineage** — Track parent→child relationships for context propagation
5. **Stall detection** — Multi-layered detection (time, output, progress, todo-based)
6. **Fallback chains** — Automatic retry with configurable fallback models

---

## REFERENCES

- **Category System**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/delegate-task/
- **Delegation Tracking**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/background-agent/
- **Session State**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/atlas/
- **Model-Specific Prompts**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus/
- **Tool Restrictions**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/shared/agent-tool-restrictions.ts
- **Stall Detection**: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/background-agent/session-idle-event-handler.ts

