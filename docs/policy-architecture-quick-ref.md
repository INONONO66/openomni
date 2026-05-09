# Policy Architecture: Quick Reference

**For**: OpenOmni middleware/guardrail/policy redesign  
**Based on**: OMO (oh-my-openagent) + Ouroboros analysis  
**Status**: Architectural recommendation (ready for implementation planning)

---

## The Problem

OpenOmni's middleware engine is currently **agent-execution-coupled**. We need to generalize it into a **universal policy layer** that covers:
- Ingress (channel auth, inbound authority)
- Subagent spawning (permission inheritance, spawn limits)
- Background task launching (resource constraints, concurrency)
- Tool execution (guards, output validation)

---

## The Solution: Three-Layer Architecture

### Layer 1: Schema (Declarative)

**What**: Define capability properties (not runtime logic)

```typescript
// Capability semantics (engine-owned, immutable)
CapabilitySemantics {
  mutation_class: "read_only" | "workspace_write" | "external_side_effect" | "destructive"
  approval_class: "default" | "elevated" | "bypass_forbidden"
  origin: "builtin" | "attached_mcp" | "provider_native"
  scope: "kernel" | "sidecar" | "attachment"
  parallel_safety: "safe" | "serialized" | "isolated_session_required"
  interruptibility: "none" | "soft" | "hard"
}

// Role profiles (what each role can do)
RoleCapabilityProfile {
  max_mutation_class: CapabilityMutationClass
  preferred_tool_names: string[]
  allowed_origins: CapabilityOrigin[]
  allowed_scopes: CapabilityScope[]
  allow_destructive: boolean
}
```

### Layer 2: Engine (Deterministic)

**How**: Evaluate policies given a context (pure functions, no state)

```typescript
// Pure function: given graph + context → decisions
evaluate_capability_policy(
  graph: CapabilityGraph,
  context: PolicyContext,
): PolicyDecision[]

// Pure function: given role → sandbox class
derive_sandbox_class(context: PolicyContext): SandboxClass
```

**Key properties**:
- ✅ Deterministic (same input → same output)
- ✅ Auditable (decisions include reasons)
- ✅ Testable (no mocks, no state)
- ✅ Composable (can be used in multiple contexts)

### Layer 3: Adapters (Translation)

**Why**: Each provider has different permission models

```typescript
// Engine decides (once)
const sandbox = derive_sandbox_class(context)

// Each provider translates (independently)
const claude_mode = claude_adapter(sandbox)      // → "default" | "acceptEdits" | "bypassPermissions"
const codex_policy = codex_adapter(sandbox)      // → cli_policy string
const custom_perms = custom_adapter(sandbox)     // → provider-specific format
```

---

## Key Design Decisions

### Decision 1: Role-Based (Not Permission-Based)

| Aspect | Role-Based | Permission-Based |
|--------|-----------|------------------|
| **Composability** | ✅ Easy (roles are semantic) | ❌ Hard (permissions are ad-hoc) |
| **Auditability** | ✅ Clear (role → sandbox) | ❌ Unclear (permissions → ?) |
| **Testability** | ✅ Simple (4 roles) | ❌ Complex (many combinations) |
| **Scalability** | ✅ Bounded (fixed roles) | ❌ Unbounded (new permissions) |

**Example**:
```typescript
// Role-based: clear
const role = PolicySessionRole.COORDINATOR
const sandbox = derive_sandbox_class({ session_role: role })
// → SandboxClass.WORKSPACE_WRITE

// Permission-based: unclear
const permissions = { edit: "allow", bash: "deny", task: "ask" }
// How do we derive sandbox class from this?
```

### Decision 2: Capability Graph as Input

**Why**: Decouples policy from tool catalog

```typescript
// Policy engine is tool-agnostic
evaluate_capability_policy(
  graph: CapabilityGraph,  // ← Input: what tools are available
  context: PolicyContext,  // ← Input: who is asking
): PolicyDecision[]        // → Output: what they can do
```

**Benefits**:
- ✅ No hardcoded tool names
- ✅ Works with builtin + MCP + provider-native tools
- ✅ Easy to test (mock graph)
- ✅ Easy to extend (add new tools)

### Decision 3: Sandbox Class as Bridge

**Why**: Single source of truth for "how much can this role do?"

```
Engine                    Providers
┌──────────────────┐     ┌──────────────────┐
│ PolicyContext    │     │ Claude SDK       │
│ ↓                │     │ permission_mode  │
│ derive_sandbox   │────→│ "default"        │
│ ↓                │     │ "acceptEdits"    │
│ SandboxClass     │     │ "bypassPermissions"
└──────────────────┘     └──────────────────┘
                         ┌──────────────────┐
                         │ Codex CLI        │
                         │ cli_policy       │
                         └──────────────────┘
                         ┌──────────────────┐
                         │ Custom Provider  │
                         │ custom_perms     │
                         └──────────────────┘
```

**Benefits**:
- ✅ Engine decides once (no duplication)
- ✅ Providers translate independently (no coupling)
- ✅ Easy to add new providers (just add adapter)
- ✅ Easy to audit (sandbox class is the decision)

### Decision 4: Separate "What" from "How"

**Schema Layer** (What):
```typescript
// Declarative: what capabilities exist
const CapabilitySemantics = z.object({
  mutation_class: z.enum([...]),
  approval_class: z.enum([...]),
  // ... no runtime logic
})
```

**Engine Layer** (How):
```typescript
// Deterministic: how to evaluate policies
function evaluate_capability_policy(graph, context) {
  // Pure function: no state, no side effects
  // Returns decisions with reasons
}
```

**Benefits**:
- ✅ Schema is stable (rarely changes)
- ✅ Engine is testable (pure functions)
- ✅ Easy to reason about (clear separation)

---

## Interception Points

### 1. Ingress (Channel Auth)

```typescript
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

### 2. Subagent Spawn (Permission Inheritance)

```typescript
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

### 3. Background Task (Resource Constraints)

```typescript
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

### 4. Tool Execution (Guards)

```typescript
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

---

## Package Structure

```
packages/policy/
├── src/
│   ├── schema/
│   │   ├── capability.ts          # CapabilitySemantics, enums
│   │   ├── role.ts                # PolicySessionRole, RoleCapabilityProfile
│   │   └── permission.ts          # PermissionValue, PermissionRule
│   │
│   ├── engine/
│   │   ├── policy-evaluator.ts    # evaluate_capability_policy()
│   │   ├── sandbox-mapper.ts      # derive_sandbox_class()
│   │   └── permission-checker.ts  # check_permission()
│   │
│   ├── context/
│   │   ├── types.ts               # PolicyContext, PolicySessionRole, PolicyExecutionPhase
│   │   ├── ingress.ts             # Ingress-specific context
│   │   ├── subagent.ts            # Subagent-specific context
│   │   ├── background.ts          # Background-specific context
│   │   └── tool.ts                # Tool-specific context
│   │
│   ├── adapter/
│   │   ├── adapter.ts             # PolicyAdapter interface
│   │   ├── claude-adapter.ts      # Claude translation
│   │   └── codex-adapter.ts       # Codex translation
│   │
│   └── index.ts                   # Public exports
│
└── tests/
    ├── policy-evaluator.test.ts
    ├── sandbox-mapper.test.ts
    └── ...
```

---

## Context Types

```typescript
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
```

---

## Example: Subagent Permission Inheritance

**Current OMO Pattern** (permission-based):
```typescript
await manager.launch({
  description: "Explore codebase",
  agent: "explore",
  parentSessionId: "ses_parent",
  sessionPermission: [
    { permission: "question", action: "deny", pattern: "*" },
  ],
})
```

**Proposed OpenOmni Pattern** (role-based):
```typescript
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

const sandbox = derive_sandbox_class(childContext)
// → SandboxClass.READ_ONLY
// → "default" (Claude SDK permission_mode)
```

---

## Implementation Roadmap

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

## Critical Insights

### 1. Permissions ≠ Policies
- **Permissions**: What you're allowed to do (schema)
- **Policies**: How we decide what you can do (engine)
- **Use both**: Permissions as rules, policies as decisions

### 2. Roles Are Composable
- Roles are semantic (easy to reason about)
- Permissions are ad-hoc (hard to compose)
- Use roles as primary abstraction

### 3. Sandbox Class Is the Bridge
- Engine decides sandbox class (once)
- Providers translate sandbox class (independently)
- Audit trail uses sandbox class (single source of truth)

### 4. Capability Graph Decouples Policy from Tools
- Policy engine takes graph as input
- No hardcoded tool names
- Works with any tool catalog

### 5. Determinism Enables Audit
- Policy decisions are pure functions
- Same input → same output (always)
- Easy to replay, test, and audit

---

## References

**Full Analysis**: `docs/policy-architecture-analysis.md`

**OMO Sources**:
- Permission Schema: `src/config/schema/internal/permission.ts`
- Hook Factory: `src/plugin/hooks/create-tool-guard-hooks.ts`
- Delegation: `src/tools/delegate-task/unstable-agent-permission.test.ts`

**Ouroboros Sources**:
- Capability Semantics: `src/ouroboros/orchestrator/capabilities.py`
- Policy Engine: `src/ouroboros/orchestrator/policy.py`
- Claude Adapter: `src/ouroboros/claude_permissions.py`

---

**Status**: Ready for implementation planning  
**Next Step**: Create `packages/policy` package and implement Phase 1
