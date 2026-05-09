# Policy/Middleware Architecture Analysis: OMO & Ouroboros

**Analysis Date**: May 2026  
**Scope**: Architectural patterns for universal policy layer in OpenOmni  
**Focus**: Tool permissions, subagent spawning, evaluation gates, and middleware patterns

---

## EXECUTIVE SUMMARY

### Key Findings

1. **OMO (oh-my-openagent)**: Hook-based interceptor pattern with **permission-first** design
   - Permissions are **declarative schemas** (Zod), not runtime logic
   - Hooks are **composable, feature-specific** (not generic middleware)
   - Delegation passes permissions **down the tree** (parent → child sessions)
   - Permission evaluation is **lazy** (checked at tool invocation time)

2. **Ouroboros**: Capability-graph + role-based policy with **semantic classification**
   - Capabilities are **engine-owned** (not provider-specific)
   - Policy decisions are **deterministic** (no runtime state)
   - Roles map to **sandbox classes** (READ_ONLY, WORKSPACE_WRITE, DESTRUCTIVE)
   - Evaluation is **multi-stage** (mechanical → semantic → consensus)

3. **Synthesis for OpenOmni**:
   - Adopt **capability semantics** (mutation class, approval class, origin, scope)
   - Use **role-based policy** (like Ouroboros) but apply to **ingress, subagent, background, channel** contexts
   - Keep **permission schema** (like OMO) as the declarative layer
   - Separate **"what to check"** (schema) from **"how to check"** (policy engine)

---

## PART 1: OMO ARCHITECTURE

### 1.1 Permission Schema (Declarative Layer)

**File**: `src/config/schema/internal/permission.ts`

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

**Key Pattern**: 
- Permissions are **Zod schemas** (type-safe, composable)
- Values are **ternary** (`ask`, `allow`, `deny`) — not binary
- Bash has **nested structure** (can restrict by command pattern)
- **No runtime logic** in the schema — just shape definition

### 1.2 Hook-Based Interceptor Pattern

**File**: `src/plugin/hooks/create-tool-guard-hooks.ts`

```typescript
export type ToolGuardHooks = {
  commentChecker: ReturnType<typeof createCommentCheckerHooks> | null
  toolOutputTruncator: ReturnType<typeof createToolOutputTruncatorHook> | null
  writeExistingFileGuard: ReturnType<typeof createWriteExistingFileGuardHook> | null
  bashFileReadGuard: ReturnType<typeof createBashFileReadGuardHook> | null
  webfetchRedirectGuard: ReturnType<typeof createWebFetchRedirectGuardHook> | null
  teamToolGating: ReturnType<typeof createTeamToolGating> | null
  // ... 11 more hooks
}

export function createToolGuardHooks(args: {
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  modelCacheState: ModelCacheState
  isHookEnabled: (hookName: HookName) => boolean
  safeHookEnabled: boolean
}): ToolGuardHooks {
  // Each hook is conditionally created based on isHookEnabled()
  // Hooks are composed into a single ToolGuardHooks object
  // Caller invokes hooks in sequence at specific interception points
}
```

**Key Pattern**:
- Hooks are **feature-specific**, not generic middleware
- Each hook has a **single responsibility** (e.g., `bashFileReadGuard` only guards bash file reads)
- Hooks are **optional** (can be disabled via config)
- Hooks are **composable** (multiple hooks can run in sequence)
- **No hook ordering** — each hook is independent

### 1.3 Delegation & Permission Propagation

**File**: `src/tools/delegate-task/unstable-agent-permission.test.ts`

```typescript
// Parent session creates child with explicit permission rules
await executeUnstableAgentTask(
  { prompt: "test prompt", ... },
  toolContext,
  executorContext,
  parentContext,
  "sisyphus-junior",
  undefined,
  undefined,
  "test-model",
)

// Permission is passed down:
expect(launchCalls[0]?.sessionPermission).toEqual([
  { permission: "question", action: "deny", pattern: "*" },
])
```

**File**: `src/features/background-agent/manager-session-permission.test.ts`

```typescript
// BackgroundManager passes parent session permissions to child
await manager.launch({
  description: "Test task",
  prompt: "Do something",
  agent: "explore",
  parentSessionId: "ses_parent",
  parentMessageId: "msg_parent",
  sessionPermission: [
    { permission: "question", action: "deny", pattern: "*" },
  ],
})

// Child session is created with inherited permissions
expect(createCalls[0]?.body).toEqual({
  parentID: "ses_parent",
  title: "Test task (@explore subagent)",
  permission: [
    { permission: "question", action: "deny", pattern: "*" },
  ],
})
```

**Key Pattern**:
- Permissions are **inherited** from parent → child
- Permissions are **explicit rules** (not inferred from role)
- Permissions are **passed at session creation time** (not at tool invocation)
- Permissions are **session-scoped** (not agent-scoped)

### 1.4 Permission Compatibility Layer

**File**: `src/shared/permission-compat.ts`

```typescript
export function createAgentToolAllowlist(allowTools: string[]): PermissionFormat {
  return {
    permission: {
      "*": "deny" as const,
      ...Object.fromEntries(
        allowTools.map((tool) => [tool, "allow" as const])
      ),
    },
  }
}

export function migrateAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  // Converts legacy tools format to permission format
  // Ensures backward compatibility
}
```

**Key Pattern**:
- Permission system has **migration layer** for backward compatibility
- Allowlist pattern: `"*": "deny"` + explicit `"allow"` entries
- Denylist pattern: explicit `"deny"` entries (implicit allow)

### 1.5 Policy Sections (Agent Behavior Constraints)

**File**: `src/agents/dynamic-agent-policy-sections.ts`

```typescript
export function buildHardBlocksSection(): string {
  const blocks = [
    "- Type error suppression (`as any`, `@ts-ignore`) - **Never**",
    "- Commit without explicit request - **Never**",
    "- Speculate about unread code - **Never**",
    "- `background_cancel(all=true)` - **Never.** Always cancel individually by taskId.",
  ]
  return `## Hard Blocks (NEVER violate)\n\n${blocks.join("\n")}`
}

export function buildAntiPatternsSection(): string {
  const patterns = [
    "- **Type Safety**: `as any`, `@ts-ignore`, `@ts-expect-error`",
    "- **Error Handling**: Empty catch blocks `catch(e) {}`",
    "- **Testing**: Deleting failing tests to \"pass\"",
  ]
  return `## Anti-Patterns (BLOCKING violations)\n\n${patterns.join("\n")}`
}
```

**Key Pattern**:
- Policy is **injected into system prompt** (not enforced at runtime)
- Policy is **declarative** (lists what agents should/shouldn't do)
- Policy is **agent-specific** (different agents get different policy sections)

---

## PART 2: OUROBOROS ARCHITECTURE

### 2.1 Capability Semantics (Engine-Owned Classification)

**File**: `src/ouroboros/orchestrator/capabilities.py`

```python
class CapabilityMutationClass(StrEnum):
    """How a capability can mutate state."""
    READ_ONLY = "read_only"
    WORKSPACE_WRITE = "workspace_write"
    EXTERNAL_SIDE_EFFECT = "external_side_effect"
    DESTRUCTIVE = "destructive"

class CapabilityParallelSafety(StrEnum):
    """How safely a capability can be used in parallel."""
    SAFE = "safe"
    SERIALIZED = "serialized"
    ISOLATED_SESSION_REQUIRED = "isolated_session_required"

class CapabilityApprovalClass(StrEnum):
    """Approval sensitivity for a capability."""
    DEFAULT = "default"
    ELEVATED = "elevated"
    BYPASS_FORBIDDEN = "bypass_forbidden"

class CapabilityOrigin(StrEnum):
    """Engine-level provenance classes for capabilities."""
    BUILTIN = "builtin"
    ATTACHED_MCP = "attached_mcp"
    PROVIDER_NATIVE = "provider_native"
    FUTURE_RUNTIME = "future_runtime"

class CapabilityScope(StrEnum):
    """Where a capability conceptually belongs."""
    KERNEL = "kernel"
    SIDECAR = "sidecar"
    ATTACHMENT = "attachment"
    SHELL_ONLY = "shell_only"

@dataclass(frozen=True, slots=True)
class CapabilitySemantics:
    """Engine semantics attached to a tool capability."""
    mutation_class: CapabilityMutationClass
    parallel_safety: CapabilityParallelSafety
    interruptibility: CapabilityInterruptibility
    approval_class: CapabilityApprovalClass
    origin: CapabilityOrigin
    scope: CapabilityScope
```

**Builtin Semantics Example**:

```python
_BUILTIN_SEMANTICS: dict[str, CapabilitySemantics] = {
    "Read": CapabilitySemantics(
        mutation_class=CapabilityMutationClass.READ_ONLY,
        parallel_safety=CapabilityParallelSafety.SAFE,
        interruptibility=CapabilityInterruptibility.NONE,
        approval_class=CapabilityApprovalClass.DEFAULT,
        origin=CapabilityOrigin.BUILTIN,
        scope=CapabilityScope.KERNEL,
    ),
    "Edit": CapabilitySemantics(
        mutation_class=CapabilityMutationClass.WORKSPACE_WRITE,
        parallel_safety=CapabilityParallelSafety.SERIALIZED,
        interruptibility=CapabilityInterruptibility.SOFT,
        approval_class=CapabilityApprovalClass.DEFAULT,
        origin=CapabilityOrigin.BUILTIN,
        scope=CapabilityScope.KERNEL,
    ),
    "Bash": CapabilitySemantics(
        mutation_class=CapabilityMutationClass.EXTERNAL_SIDE_EFFECT,
        parallel_safety=CapabilityParallelSafety.ISOLATED_SESSION_REQUIRED,
        interruptibility=CapabilityInterruptibility.HARD,
        approval_class=CapabilityApprovalClass.ELEVATED,
        origin=CapabilityOrigin.BUILTIN,
        scope=CapabilityScope.SHELL_ONLY,
    ),
}
```

**Key Pattern**:
- Semantics are **engine-owned** (not provider-specific)
- Semantics are **immutable** (frozen dataclass)
- Semantics are **multi-dimensional** (mutation, parallelism, interruptibility, approval, origin, scope)
- Semantics are **declarative** (no runtime logic)

### 2.2 Role-Based Policy Engine

**File**: `src/ouroboros/orchestrator/policy.py`

```python
class PolicySessionRole(StrEnum):
    """Supported engine-level session roles."""
    IMPLEMENTATION = "implementation"
    COORDINATOR = "coordinator"
    INTERVIEW = "interview"
    EVALUATION = "evaluation"

@dataclass(frozen=True, slots=True)
class RoleCapabilityProfile:
    """Declarative envelope for a session role."""
    max_mutation_class: CapabilityMutationClass
    preferred_tool_names: tuple[str, ...] = ()
    allowed_origins: tuple[CapabilityOrigin, ...] = ()
    allowed_scopes: tuple[CapabilityScope, ...] = ()
    allow_destructive: bool = False

_ROLE_PROFILES = {
    PolicySessionRole.IMPLEMENTATION: RoleCapabilityProfile(
        max_mutation_class=CapabilityMutationClass.DESTRUCTIVE,
        allow_destructive=True,
    ),
    PolicySessionRole.COORDINATOR: RoleCapabilityProfile(
        max_mutation_class=CapabilityMutationClass.EXTERNAL_SIDE_EFFECT,
        preferred_tool_names=("Read", "Bash", "Edit", "Grep", "Glob"),
        allowed_origins=(CapabilityOrigin.PROVIDER_NATIVE, CapabilityOrigin.FUTURE_RUNTIME),
        allowed_scopes=(
            CapabilityScope.KERNEL,
            CapabilityScope.SIDECAR,
            CapabilityScope.SHELL_ONLY,
        ),
    ),
    PolicySessionRole.INTERVIEW: RoleCapabilityProfile(
        max_mutation_class=CapabilityMutationClass.READ_ONLY,
        preferred_tool_names=("Read", "Grep", "Glob", "WebFetch", "WebSearch"),
        allowed_origins=(CapabilityOrigin.PROVIDER_NATIVE, CapabilityOrigin.FUTURE_RUNTIME),
        allowed_scopes=(CapabilityScope.KERNEL, CapabilityScope.SIDECAR),
    ),
    PolicySessionRole.EVALUATION: RoleCapabilityProfile(
        max_mutation_class=CapabilityMutationClass.READ_ONLY,
        preferred_tool_names=("Read", "Grep", "Glob", "WebFetch", "WebSearch"),
        allowed_origins=(CapabilityOrigin.PROVIDER_NATIVE, CapabilityOrigin.FUTURE_RUNTIME),
        allowed_scopes=(CapabilityScope.KERNEL, CapabilityScope.SIDECAR),
    ),
}

def evaluate_capability_policy(
    graph: CapabilityGraph,
    context: PolicyContext,
) -> tuple[PolicyDecision, ...]:
    """Evaluate visible/executable capability decisions for a session role."""
    profile = _ROLE_PROFILES[context.session_role]
    decisions: list[PolicyDecision] = []

    for descriptor in graph.capabilities:
        reasons: list[str] = []
        visible = _is_mutation_allowed(descriptor, profile)
        executable = visible

        if visible and not _matches_role_selector(descriptor, profile):
            visible = False
            executable = False
            reasons.append(
                f"{context.session_role.value} profile does not include {descriptor.name}"
            )
        elif not visible:
            reasons.append(
                f"mutation_class {descriptor.semantics.mutation_class.value} exceeds "
                f"{context.session_role.value} policy"
            )

        decisions.append(
            PolicyDecision(
                stable_id=descriptor.stable_id,
                name=descriptor.name,
                visible=visible,
                executable=executable,
                approval_class=descriptor.semantics.approval_class,
                reasons=tuple(reasons),
            )
        )

    return tuple(decisions)
```

**Key Pattern**:
- Policy is **role-based** (not permission-based)
- Policy evaluation is **deterministic** (no state, pure function)
- Policy decisions include **reasons** (for debugging/audit)
- Policy uses **two-clause matching** (explicit name allowlist OR semantic matching)

### 2.3 Sandbox Class Mapping

**File**: `src/ouroboros/orchestrator/policy.py`

```python
_ROLE_SANDBOX_CLASS: dict[PolicySessionRole, SandboxClass] = {
    PolicySessionRole.INTERVIEW: SandboxClass.READ_ONLY,
    PolicySessionRole.EVALUATION: SandboxClass.READ_ONLY,
    PolicySessionRole.COORDINATOR: SandboxClass.WORKSPACE_WRITE,
    PolicySessionRole.IMPLEMENTATION: SandboxClass.UNRESTRICTED,
}

def derive_sandbox_class(context: PolicyContext) -> SandboxClass:
    """Return the backend-neutral sandbox class implied by a policy context.
    
    This is the engine's authoritative answer to "what sandbox level does
    this session deserve?".  Provider adapters must translate the returned
    enum to their runtime-specific shape via a lookup table; they must not
    recompute the decision from free-form permission strings.
    """
    return _ROLE_SANDBOX_CLASS[context.session_role]
```

**Key Pattern**:
- Sandbox class is **engine-owned** (not provider-specific)
- Sandbox class is **derived from role** (not from permissions)
- Provider adapters **translate** (not re-decide)

### 2.4 Provider-Specific Translation

**File**: `src/ouroboros/claude_permissions.py`

```python
ClaudePermissionMode = Literal["default", "acceptEdits", "bypassPermissions"]

_SANDBOX_TO_CLAUDE_MODE: dict[SandboxClass, ClaudePermissionMode] = {
    SandboxClass.READ_ONLY: "default",
    SandboxClass.WORKSPACE_WRITE: "acceptEdits",
    SandboxClass.UNRESTRICTED: "bypassPermissions",
}

def claude_permission_mode_for_sandbox(sandbox: SandboxClass) -> ClaudePermissionMode:
    """Translate an engine sandbox class into a Claude SDK permission_mode.
    
    Raises ``KeyError`` if the enum grows and Claude's table was not updated —
    failing loudly beats silently defaulting to a possibly-permissive mode.
    """
    mode = _SANDBOX_TO_CLAUDE_MODE.get(sandbox)
    if mode is None:
        msg = f"No Claude SDK permission_mode registered for sandbox class {sandbox!r}"
        raise KeyError(msg)
    if sandbox is SandboxClass.UNRESTRICTED:
        log.warning("permissions.bypass_activated", sandbox=sandbox.value)
    return mode
```

**Key Pattern**:
- Translation is **explicit** (lookup table, not inference)
- Translation **fails loudly** (KeyError if missing)
- Translation is **provider-specific** (each provider has its own table)

### 2.5 Multi-Stage Evaluation Pipeline

**File**: `src/ouroboros/evaluation/pipeline.py`

```python
@dataclass(frozen=True, slots=True)
class PipelineConfig:
    """Configuration for the evaluation pipeline."""
    stage1_enabled: bool = True
    stage2_enabled: bool = True
    stage3_enabled: bool = True
    mechanical: MechanicalConfig | None = None
    semantic: SemanticConfig | None = None
    consensus: ConsensusConfig | None = None
    trigger: TriggerConfig | None = None

class EvaluationPipeline:
    """Orchestrates the three-stage evaluation pipeline.
    
    Stage 1: Mechanical Verification (lint, build, test, static, coverage)
    Stage 2: Semantic Evaluation (LLM-based compliance check)
    Stage 3: Multi-Model Consensus (if triggered by drift/uncertainty)
    """
    
    async def evaluate(
        self,
        context: EvaluationContext,
        trigger_context: TriggerContext | None = None,
        *,
        stage1_result: MechanicalResult | None = None,
    ) -> Result[EvaluationResult, ProviderError | ValidationError]:
        """Run the evaluation pipeline.
        
        Stage 1 can be pre-computed and shared across multiple semantic evaluations.
        Stage 3 is only triggered if conditions are met (drift, uncertainty, manual request).
        """
```

**Key Pattern**:
- Evaluation is **multi-stage** (mechanical → semantic → consensus)
- Stages are **optional** (can be disabled via config)
- Stages are **sequential** (earlier stages gate later ones)
- Stage 1 is **shareable** (can be pre-computed and reused)
- Stage 3 is **triggered** (not always run)

---

## PART 3: SYNTHESIS FOR OPENOMNI

### 3.1 Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ POLICY LAYER (Universal)                                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ SCHEMA LAYER (Declarative)                           │  │
│  │ - Capability Semantics (mutation, approval, origin)  │  │
│  │ - Role Profiles (max_mutation, preferred_tools)      │  │
│  │ - Permission Rules (allow/deny/ask patterns)         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ POLICY ENGINE (Deterministic)                        │  │
│  │ - evaluate_capability_policy(graph, context)         │  │
│  │ - derive_sandbox_class(context)                      │  │
│  │ - check_permission(rule, action)                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ INTERCEPTION POINTS (Context-Specific)               │  │
│  │ - Ingress: channel auth, inbound authority           │  │
│  │ - Subagent: spawn limits, permission inheritance     │  │
│  │ - Background: task limits, resource constraints      │  │
│  │ - Tool: execution guards, output validation          │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ PROVIDER ADAPTERS (Translation)                      │  │
│  │ - Claude: sandbox_class → permission_mode            │  │
│  │ - Codex: sandbox_class → cli_policy                  │  │
│  │ - Custom: sandbox_class → provider-specific format   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Package Structure

```
packages/policy/
├── src/
│   ├── schema/
│   │   ├── capability.ts          # CapabilitySemantics, CapabilityMutationClass, etc.
│   │   ├── role.ts                # PolicySessionRole, RoleCapabilityProfile
│   │   └── permission.ts          # PermissionValue, PermissionRule
│   │
│   ├── engine/
│   │   ├── policy-evaluator.ts    # evaluate_capability_policy()
│   │   ├── sandbox-mapper.ts      # derive_sandbox_class()
│   │   └── permission-checker.ts  # check_permission()
│   │
│   ├── context/
│   │   ├── ingress-context.ts     # PolicyContext for ingress
│   │   ├── subagent-context.ts    # PolicyContext for subagent spawn
│   │   ├── background-context.ts  # PolicyContext for background tasks
│   │   └── tool-context.ts        # PolicyContext for tool execution
│   │
│   ├── adapter/
│   │   ├── adapter.ts             # PolicyAdapter interface
│   │   ├── claude-adapter.ts      # Claude-specific translation
│   │   └── codex-adapter.ts       # Codex-specific translation
│   │
│   └── index.ts                   # Public exports
│
└── tests/
    ├── policy-evaluator.test.ts
    ├── sandbox-mapper.test.ts
    └── ...
```

### 3.3 Key Design Decisions

#### Decision 1: Separate "What" from "How"

**What** (Schema Layer):
```typescript
// Declarative: what capabilities exist and their properties
const CapabilitySemantics = z.object({
  mutation_class: z.enum(["read_only", "workspace_write", "external_side_effect", "destructive"]),
  approval_class: z.enum(["default", "elevated", "bypass_forbidden"]),
  origin: z.enum(["builtin", "attached_mcp", "provider_native"]),
  scope: z.enum(["kernel", "sidecar", "attachment"]),
})
```

**How** (Policy Engine):
```typescript
// Deterministic: how to evaluate policies given a context
function evaluate_capability_policy(
  graph: CapabilityGraph,
  context: PolicyContext,
): PolicyDecision[] {
  // Pure function: no state, no side effects
  // Returns decisions with reasons for audit
}
```

#### Decision 2: Role-Based (Not Permission-Based)

**Why**: Roles are **composable** and **auditable**

```typescript
// Role-based: easier to reason about
const role = PolicySessionRole.COORDINATOR
const sandbox = derive_sandbox_class({ session_role: role })
// → SandboxClass.WORKSPACE_WRITE

// Permission-based: harder to compose
const permissions = { edit: "allow", bash: "deny", task: "ask" }
// How do we derive sandbox class from this?
```

#### Decision 3: Capability Graph as Input

**Why**: Decouples policy from tool catalog

```typescript
// Policy engine is tool-agnostic
function evaluate_capability_policy(
  graph: CapabilityGraph,  // Input: what tools are available
  context: PolicyContext,  // Input: who is asking
): PolicyDecision[] {      // Output: what they can do
  // No hardcoded tool names
  // No provider-specific logic
}
```

#### Decision 4: Sandbox Class as Bridge

**Why**: Single source of truth for "how much can this role do?"

```typescript
// Engine decides sandbox class (once)
const sandbox = derive_sandbox_class(context)

// Each provider translates (independently)
const claude_mode = claude_permission_mode_for_sandbox(sandbox)
const codex_policy = codex_cli_policy_for_sandbox(sandbox)
const custom_perms = custom_adapter_for_sandbox(sandbox)
```

### 3.4 Interception Points

#### Ingress Interception

```typescript
// packages/openomni/src/ingress/policy-guard.ts
async function checkIngressPolicy(
  event: InboundEvent,
  context: PolicyContext,
): Promise<PolicyDecision> {
  // Check: Is this channel authorized?
  // Check: Is this user allowed to create top-level work?
  // Check: Does this mode match the session role?
  
  const graph = buildCapabilityGraph(event.availableTools)
  return evaluate_capability_policy(graph, context)
}
```

#### Subagent Spawn Interception

```typescript
// packages/openomni/src/subagent/policy-guard.ts
async function checkSubagentSpawnPolicy(
  spawn: SubagentSpawnRequest,
  parentContext: PolicyContext,
): Promise<PolicyDecision> {
  // Check: Can parent spawn children?
  // Check: What permissions should child inherit?
  // Check: Are we within spawn limits?
  
  const childContext = deriveChildContext(parentContext, spawn)
  const graph = buildCapabilityGraph(spawn.availableTools)
  return evaluate_capability_policy(graph, childContext)
}
```

#### Background Task Interception

```typescript
// packages/openomni/src/background/policy-guard.ts
async function checkBackgroundTaskPolicy(
  task: BackgroundTaskRequest,
  context: PolicyContext,
): Promise<PolicyDecision> {
  // Check: Can this agent launch background tasks?
  // Check: Are we within concurrency limits?
  // Check: What sandbox should the background task run in?
  
  const graph = buildCapabilityGraph(task.availableTools)
  return evaluate_capability_policy(graph, context)
}
```

#### Tool Execution Interception

```typescript
// packages/agent/src/core/execution/policy-guard.ts
async function checkToolExecutionPolicy(
  toolCall: ToolCall,
  context: PolicyContext,
): Promise<PolicyDecision> {
  // Check: Is this tool visible to this role?
  // Check: Is this tool executable (not inherited)?
  // Check: Does this tool require elevated approval?
  
  const graph = buildCapabilityGraph(context.availableTools)
  const decisions = evaluate_capability_policy(graph, context)
  return decisions.find(d => d.name === toolCall.name)
}
```

### 3.5 Context Types

```typescript
// packages/policy/src/context/types.ts

export interface PolicyContext {
  // Who is asking?
  session_role: PolicySessionRole
  agent_id?: string
  user_id?: string
  
  // What are they doing?
  execution_phase: PolicyExecutionPhase
  action: "read" | "write" | "execute" | "spawn" | "delegate"
  
  // Where are they doing it?
  runtime_backend?: string
  channel?: string
  
  // What tools are available?
  available_tools: string[]
  
  // Audit trail
  parent_context?: PolicyContext
  reason?: string
}

export enum PolicySessionRole {
  MAIN = "main",              // Main persona (user-facing)
  SUBAGENT = "subagent",      // Specialized worker
  BACKGROUND = "background",  // Fire-and-forget task
  COORDINATOR = "coordinator", // Multi-agent orchestrator
  EVALUATOR = "evaluator",    // Quality gate
}

export enum PolicyExecutionPhase {
  INGRESS = "ingress",
  SUBAGENT_SPAWN = "subagent_spawn",
  BACKGROUND_LAUNCH = "background_launch",
  TOOL_EXECUTION = "tool_execution",
  EVALUATION = "evaluation",
}
```

### 3.6 Example: Subagent Permission Inheritance

```typescript
// Current OMO pattern (permission-based)
await manager.launch({
  description: "Explore codebase",
  agent: "explore",
  parentSessionId: "ses_parent",
  sessionPermission: [
    { permission: "question", action: "deny", pattern: "*" },
  ],
})

// Proposed OpenOmni pattern (role-based)
const parentContext: PolicyContext = {
  session_role: PolicySessionRole.MAIN,
  execution_phase: PolicyExecutionPhase.SUBAGENT_SPAWN,
  available_tools: ["Read", "Grep", "Glob", "WebFetch"],
}

const childContext = deriveChildContext(parentContext, {
  agent: "explore",
  spawn_type: "background",
})
// → { session_role: SUBAGENT, execution_phase: SUBAGENT_SPAWN, ... }

const decisions = evaluate_capability_policy(graph, childContext)
// → [
//     { name: "Read", visible: true, executable: true, ... },
//     { name: "Grep", visible: true, executable: true, ... },
//     { name: "Edit", visible: false, executable: false, ... },
//     { name: "Bash", visible: false, executable: false, ... },
//   ]

// Translate to provider-specific format
const claude_mode = derive_sandbox_class(childContext)
// → SandboxClass.READ_ONLY
// → "default" (Claude SDK permission_mode)
```

---

## PART 4: IMPLEMENTATION ROADMAP

### Phase 1: Schema & Engine (Weeks 1-2)

- [ ] Create `packages/policy` package
- [ ] Implement `CapabilitySemantics` schema (Zod)
- [ ] Implement `PolicySessionRole` enum
- [ ] Implement `evaluate_capability_policy()` engine
- [ ] Implement `derive_sandbox_class()` mapper
- [ ] Add comprehensive tests

### Phase 2: Interception Points (Weeks 3-4)

- [ ] Ingress policy guard
- [ ] Subagent spawn policy guard
- [ ] Background task policy guard
- [ ] Tool execution policy guard
- [ ] Integration tests

### Phase 3: Provider Adapters (Weeks 5-6)

- [ ] Claude adapter (sandbox_class → permission_mode)
- [ ] Codex adapter (sandbox_class → cli_policy)
- [ ] Custom adapter interface
- [ ] Migration from existing permission system

### Phase 4: Observability & Audit (Weeks 7-8)

- [ ] Policy decision logging
- [ ] Audit trail (who did what, why)
- [ ] Policy violation alerts
- [ ] Dashboard/reporting

---

## PART 5: COMPARISON TABLE

| Aspect | OMO | Ouroboros | OpenOmni (Proposed) |
|--------|-----|-----------|---------------------|
| **Permission Model** | Ternary (ask/allow/deny) | Role-based | Role-based + permission rules |
| **Interception** | Hook-based (feature-specific) | Policy engine (deterministic) | Policy engine + context-specific guards |
| **Capability Classification** | Implicit (in hooks) | Explicit (CapabilitySemantics) | Explicit (CapabilitySemantics) |
| **Delegation** | Permission inheritance | Role derivation | Role derivation + permission inheritance |
| **Evaluation** | Lazy (at tool invocation) | Eager (at session creation) | Eager (at session/spawn/task creation) |
| **Provider Translation** | Implicit (in hooks) | Explicit (lookup table) | Explicit (adapter interface) |
| **Audit Trail** | Implicit (in logs) | Explicit (PolicyDecision.reasons) | Explicit (PolicyDecision + audit events) |
| **Composability** | High (many independent hooks) | Medium (role-based) | High (role-based + permission rules) |
| **Testability** | Medium (hooks are stateful) | High (pure functions) | High (pure functions) |

---

## PART 6: CRITICAL INSIGHTS

### Insight 1: Permissions ≠ Policies

**OMO**: Permissions are **what you're allowed to do** (schema)  
**Ouroboros**: Policies are **how we decide what you can do** (engine)

**For OpenOmni**: Use both:
- Permissions as **declarative rules** (like OMO)
- Policies as **deterministic decisions** (like Ouroboros)

### Insight 2: Roles Are Composable

**OMO**: Hooks are feature-specific (hard to compose)  
**Ouroboros**: Roles are semantic (easy to compose)

**For OpenOmni**: Use roles as the primary abstraction, with permission rules as overrides.

### Insight 3: Sandbox Class Is the Bridge

**Ouroboros**: Sandbox class is the **single source of truth** for "how much can this role do?"

**For OpenOmni**: Use sandbox class to bridge:
- Engine (policy decisions)
- Providers (permission_mode, cli_policy, etc.)
- Audit (what level of access was granted)

### Insight 4: Capability Graph Decouples Policy from Tools

**Ouroboros**: Policy engine takes a capability graph as input (not hardcoded tool names)

**For OpenOmni**: Build capability graph from:
- Builtin tools (Read, Edit, Bash, etc.)
- MCP tools (attached at runtime)
- Provider-native tools (Claude Code, etc.)

### Insight 5: Determinism Enables Audit

**Ouroboros**: Policy decisions are deterministic (pure functions)

**For OpenOmni**: This enables:
- Replay (given same context, same decision)
- Audit (why was this decision made?)
- Testing (no mocks, no state)

---

## REFERENCES

### OMO (oh-my-openagent)

- **Permission Schema**: `src/config/schema/internal/permission.ts`
- **Hook Factory**: `src/plugin/hooks/create-tool-guard-hooks.ts`
- **Delegation**: `src/tools/delegate-task/unstable-agent-permission.test.ts`
- **Permission Compat**: `src/shared/permission-compat.ts`
- **Policy Sections**: `src/agents/dynamic-agent-policy-sections.ts`

### Ouroboros

- **Capability Semantics**: `src/ouroboros/orchestrator/capabilities.py`
- **Policy Engine**: `src/ouroboros/orchestrator/policy.py`
- **Claude Adapter**: `src/ouroboros/claude_permissions.py`
- **Evaluation Pipeline**: `src/ouroboros/evaluation/pipeline.py`
- **Router Dispatch**: `src/ouroboros/router/dispatch.py`

---

**Analysis Complete** | May 2026
