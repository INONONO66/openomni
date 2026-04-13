# Hermes Agent — Complete Engineering Architecture Analysis

**Date**: April 2026  
**Source**: https://github.com/NousResearch/hermes-agent (main branch)  
**Analysis Scope**: Core agent loop, skill system, memory, context compression, tool delegation, multi-platform gateway, profile system, MCP integration

---

## EXECUTIVE SUMMARY

Hermes Agent is a **self-improving, multi-platform AI agent framework** built by Nous Research. It implements a closed-loop learning system where:

1. **Agent Loop** (run_agent.py): Synchronous ReAct loop with tool calling, parallel execution, and budget management
2. **Skill System**: Autonomous skill creation + self-improvement during use (SKILL.md format, agentskills.io compatible)
3. **Memory**: Pluggable memory providers (built-in + external), FTS5 session search, user profiling
4. **Context Compression**: 4-stage lossy summarization with iterative updates and token budgets
5. **Tool Delegation**: Subagent spawning with isolated context, restricted toolsets, parallel execution
6. **Multi-Platform Gateway**: Single process serving CLI/Telegram/Discord/Slack/WhatsApp/Signal/Email
7. **Profile System**: Multi-instance isolation with per-profile HERMES_HOME
8. **MCP Integration**: External MCP servers with stdio/HTTP transport, sampling support, dynamic tool discovery

---

## 1. CORE AGENT LOOP (run_agent.py)

### 1.1 AIAgent Class Structure

**File**: `run_agent.py` (10,524 lines)

```python
class AIAgent:
    def __init__(self,
        model: str = "anthropic/claude-opus-4.6",
        max_iterations: int = 90,
        enabled_toolsets: list = None,
        disabled_toolsets: list = None,
        quiet_mode: bool = False,
        save_trajectories: bool = False,
        platform: str = None,           # "cli", "telegram", etc.
        session_id: str = None,
        skip_context_files: bool = False,
        skip_memory: bool = False,
        # ... provider, api_mode, callbacks, routing params
    ): ...

    def chat(self, message: str) -> str:
        """Simple interface — returns final response string."""

    def run_conversation(self, user_message: str, system_message: str = None,
                         conversation_history: list = None, task_id: str = None) -> dict:
        """Full interface — returns dict with final_response + messages."""
```

**Key Design**:
- **Synchronous**: No async/await in the main loop (async tools are bridged via `_run_async()`)
- **Budget-aware**: `IterationBudget` class tracks remaining iterations (parent: 90, subagent: 50)
- **Parallel-safe**: Parallel tool execution with path-scoped locking for file tools
- **Interrupt-safe**: `_SafeWriter` wrapper catches broken pipes in headless/container environments

### 1.2 The Conversation Loop

**Location**: `run_agent.py:run_conversation()` (lines ~1200-2500)

```
while api_call_count < max_iterations and budget.remaining > 0:
    1. Build system prompt (memory + skills + context files + compression summary)
    2. Apply Anthropic prompt caching (if supported)
    3. Call LLM with messages + tool schemas
    4. If tool_calls:
       a. Parallelize if safe (path-scoped, no interactive tools)
       b. Execute each tool via handle_function_call()
       c. Append tool results to messages
       d. Increment api_call_count
    5. Else:
       Return response.content
```

**Message Format**: OpenAI-compatible
```python
{
    "role": "system/user/assistant/tool",
    "content": "...",
    "tool_calls": [...],      # assistant messages only
    "tool_call_id": "...",    # tool messages only
    "reasoning": "...",       # extended thinking (Claude)
}
```

### 1.3 Tool Execution Pipeline

**Location**: `model_tools.py:handle_function_call()` (lines ~300-400)

```python
def handle_function_call(function_name: str, function_args: dict, 
                         task_id: str = None, user_task: str = None) -> str:
    """
    1. Route to memory manager if memory tool
    2. Route to registry.dispatch() for all other tools
    3. Wrap result in JSON
    4. Enforce result size limits (per-tool + global)
    5. Return JSON string
    """
```

**Tool Registry** (`tools/registry.py`):
- Central `ToolRegistry` singleton
- Each tool file calls `registry.register()` at import time
- Schema + handler + availability check + async flag
- 194 tool files total (40+ built-in tools)

### 1.4 Parallel Tool Execution

**Location**: `run_agent.py:_should_parallelize_tool_batch()` (lines ~267-350)

**Rules**:
- Single tool → sequential
- Multiple tools → parallelize if:
  - No interactive tools (`clarify`)
  - No path conflicts (file tools on same path)
  - All tools are in `_PARALLEL_SAFE_TOOLS` OR have independent scopes
- Max 8 concurrent workers (`_MAX_TOOL_WORKERS`)

**Path Scoping** (file tools):
```python
_PATH_SCOPED_TOOLS = {"read_file", "write_file", "patch"}
# Detect overlapping paths, fall back to sequential if conflict
```

### 1.5 Iteration Budget & Refunds

**Location**: `run_agent.py:IterationBudget` (lines ~170-212)

```python
class IterationBudget:
    def __init__(self, max_total: int):
        self.max_total = max_total  # 90 for parent, 50 for subagent
        self._used = 0
        self._lock = threading.Lock()
    
    def consume(self) -> bool:
        """Try to consume one iteration. Returns True if allowed."""
    
    def refund(self) -> None:
        """Give back one iteration (e.g., for execute_code turns)."""
```

**Refund Logic**:
- `execute_code` tool calls are refunded (don't count toward budget)
- Allows programmatic tool calling without burning iterations
- Subagents get independent budgets (no shared pool)

---

## 2. SKILL SYSTEM

### 2.1 Skill Definition & Storage

**Location**: `tools/skills_tool.py` (1,358 lines)

**Directory Structure**:
```
~/.hermes/skills/
├── my-skill/
│   ├── SKILL.md           # Main instructions (required)
│   ├── references/        # Supporting docs
│   │   ├── api.md
│   │   └── examples.md
│   ├── templates/         # Output templates
│   └── assets/            # Supplementary files
└── category/
    └── another-skill/
        └── SKILL.md
```

**SKILL.md Format** (YAML Frontmatter + Markdown):
```yaml
---
name: skill-name              # Required, max 64 chars
description: Brief desc       # Required, max 1024 chars
version: 1.0.0                # Optional
license: MIT                  # Optional (agentskills.io)
platforms: [macos, linux]     # Optional — OS restrictions
prerequisites:                # Optional
  env_vars: [API_KEY]
  commands: [curl, jq]
compatibility: Requires X     # Optional (agentskills.io)
metadata:                     # Optional
  hermes:
    tags: [fine-tuning, llm]
    related_skills: [peft, lora]
setup:                        # Optional — interactive setup
  help: "Setup instructions"
  collect_secrets:
    - env_var: API_KEY
      prompt: "Enter your API key"
      provider_url: "https://..."
      secret: true
---

# Skill Title

Full instructions and content here...
```

**Progressive Disclosure** (token efficiency):
1. `skills_list()` → metadata only (name, description, version)
2. `skill_view(name)` → full SKILL.md content
3. `skill_view(name, "references/file.md")` → linked files on demand

### 2.2 Skill Injection into Conversation

**Location**: `agent/skill_commands.py` (lines ~50-150)

**Mechanism**:
- Scan `~/.hermes/skills/` at startup
- Each skill becomes a slash command (e.g., `/axolotl`)
- When invoked, skill content is injected as **user message** (not system prompt)
- Preserves Anthropic prompt caching (system prompt unchanged)

**Example Flow**:
```
User: /axolotl
→ Load ~/.hermes/skills/axolotl/SKILL.md
→ Inject as user message: "Here is a skill:\n\n[SKILL.md content]"
→ Agent processes skill + user's follow-up in same turn
```

### 2.3 Autonomous Skill Creation

**Location**: `tools/skill_manager_tool.py` (lines ~1-500)

**Trigger**: After complex multi-turn tasks (configurable threshold)

**Process**:
1. Detect task complexity (tool call count, reasoning depth)
2. Summarize task + solution via auxiliary LLM
3. Generate SKILL.md with:
   - Name (auto-generated from task)
   - Description (summarized outcome)
   - Prerequisites (detected env vars, commands)
   - Full instructions (step-by-step from conversation)
4. Save to `~/.hermes/skills/auto-generated/[skill-name]/SKILL.md`
5. Make available immediately (no restart needed)

**Self-Improvement During Use**:
- Track skill invocations + outcomes
- On repeated use, refine instructions based on feedback
- Update SKILL.md in-place (version bump)
- Collect user corrections via `/skill edit` command

### 2.4 Skill Readiness & Platform Filtering

**Location**: `tools/skills_tool.py:skill_matches_platform()` (lines ~134-141)

```python
def skill_matches_platform(frontmatter: Dict[str, Any]) -> bool:
    """Check if skill is compatible with current OS platform."""
    platforms = frontmatter.get("platforms", [])
    if not platforms:
        return True  # No restriction = available everywhere
    
    import sys
    current = "darwin" if sys.platform == "darwin" else sys.platform
    return any(p in current for p in platforms)
```

**Readiness Status**:
```python
class SkillReadinessStatus(str, Enum):
    AVAILABLE = "available"
    SETUP_NEEDED = "setup_needed"
    UNSUPPORTED = "unsupported"
```

---

## 3. MEMORY SYSTEM

### 3.1 Memory Architecture

**Location**: `agent/memory_manager.py` (362 lines)

**Design**:
- **Built-in provider** (always registered first)
- **At most ONE external provider** (plugin-based)
- Failures in one provider don't block the other
- Single integration point in `run_agent.py`

```python
class MemoryManager:
    def __init__(self):
        self._providers: List[MemoryProvider] = []
        self._tool_to_provider: Dict[str, MemoryProvider] = {}
        self._has_external: bool = False
    
    def add_provider(self, provider: MemoryProvider) -> None:
        """Register a memory provider.
        
        Built-in provider (name "builtin") always accepted.
        Only ONE external provider allowed.
        """
```

### 3.2 Built-in Memory Provider

**Location**: `agent/memory_provider.py` (base class)

**Files**:
- `~/.hermes/MEMORY.md` — persistent facts, learnings, preferences
- `~/.hermes/USER.md` — user profile, personality, communication style

**Tools**:
- `memory_add(content)` — append to MEMORY.md
- `memory_search(query)` — FTS5 search across session history
- `memory_view()` — read current MEMORY.md
- `user_profile_update(content)` — update USER.md

### 3.3 External Memory Providers (Plugins)

**Location**: `plugins/memory/` (4 implementations)

**Supported**:
1. **Honcho** (`plugins/memory/honcho/`) — Dialectic user modeling (OpenClaw compatible)
2. **Holographic** (`plugins/memory/holographic/`) — Vector-based retrieval
3. **RetainDB** (`plugins/memory/retaindb/`) — Persistent graph database
4. **OpenViking** (`plugins/memory/openviking/`) — Custom memory backend

**Configuration** (`config.yaml`):
```yaml
memory:
  provider: "honcho"  # or "holographic", "retaindb", "openviking"
  # Provider-specific config
```

### 3.4 Session Search & FTS5

**Location**: `hermes_state.py` (1,238 lines)

**Database Schema**:
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,        -- "cli", "telegram", "discord", etc.
    user_id TEXT,
    model TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    message_count INTEGER,
    tool_call_count INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    estimated_cost_usd REAL,
    title TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,           -- "system", "user", "assistant", "tool"
    content TEXT,
    tool_calls TEXT,              -- JSON array
    timestamp REAL NOT NULL,
    token_count INTEGER,
    reasoning TEXT,               -- extended thinking
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);
```

**Write Contention Handling**:
- WAL mode for concurrent readers + single writer
- Application-level retry with random jitter (20-150ms)
- Breaks convoy effects from SQLite's deterministic backoff
- Periodic PASSIVE checkpoint every 50 writes

**Session Search Tool** (`tools/session_search_tool.py`):
```python
def session_search(query: str, days: int = 30, limit: int = 5) -> str:
    """
    1. FTS5 search across messages in last N days
    2. Summarize results via auxiliary LLM
    3. Return cross-session recall context
    """
```

### 3.5 Memory Prefetch & Sync Cycle

**Location**: `run_agent.py:run_conversation()` (lines ~1300-1400)

**Pre-Turn**:
```python
# Prefetch memory context before LLM call
memory_context = self._memory_manager.prefetch_all(user_message, session_id=session_id)
# Wrap in fence tags to prevent model treating it as user input
memory_block = build_memory_context_block(memory_context)
# Inject into system prompt or user message
```

**Post-Turn**:
```python
# Sync completed turn to all providers
self._memory_manager.sync_all(user_content, assistant_content, session_id=session_id)
# Queue background prefetch for next turn
self._memory_manager.queue_prefetch_all(user_message, session_id=session_id)
```

---

## 4. CONTEXT COMPRESSION (4-Stage Algorithm)

### 4.1 ContextCompressor Class

**Location**: `agent/context_compressor.py` (820 lines)

**Algorithm**:
```
Stage 1: Prune old tool results (cheap, no LLM)
         Replace content >200 chars with placeholder

Stage 2: Protect head messages (system + first exchange)
         protect_first_n = 3 (default)

Stage 3: Protect tail messages by token budget
         protect_last_n = 20 (default)
         OR protect_tail_tokens = threshold * summary_ratio

Stage 4: Summarize middle turns with structured LLM prompt
         Iteratively update previous summary on subsequent compressions
```

### 4.2 Compression Thresholds & Budgets

**Configuration**:
```python
def __init__(self,
    model: str,
    threshold_percent: float = 0.50,      # Compress at 50% of context window
    protect_first_n: int = 3,
    protect_last_n: int = 20,
    summary_target_ratio: float = 0.20,   # Summary = 20% of compressed content
    summary_model_override: str = None,
    config_context_length: int | None = None,
):
    self.context_length = get_model_context_length(model)
    self.threshold_tokens = max(
        int(self.context_length * threshold_percent),
        MINIMUM_CONTEXT_LENGTH,  # Never compress below 8K tokens
    )
    self.tail_token_budget = int(self.threshold_tokens * summary_target_ratio)
    self.max_summary_tokens = min(
        int(self.context_length * 0.05),  # 5% of context window
        _SUMMARY_TOKENS_CEILING,          # Cap at 12K tokens
    )
```

### 4.3 Summarization Prompt

**Location**: `agent/context_compressor.py:_build_summary_prompt()` (lines ~300-400)

**Template**:
```
[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted 
into the summary below. This is a handoff from a previous context 
window — treat it as background reference, NOT as active instructions.

PREVIOUS SUMMARY (if any):
[Iteratively updated summary from last compression]

TURNS TO SUMMARIZE:
[Middle messages with tool calls/results]

INSTRUCTIONS:
- Preserve resolved questions and completed work
- Track pending questions and remaining work
- Note any files created/modified
- Summarize tool outputs (not full content)
- Use structured format: Resolved / Pending / Remaining Work

OUTPUT FORMAT:
## Summary

**Resolved Questions:**
- ...

**Pending Questions:**
- ...

**Remaining Work:**
- ...
```

### 4.4 Tool Output Pruning

**Location**: `agent/context_compressor.py:_prune_old_tool_results()` (lines ~186-241)

```python
def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
    """
    Walk backward from end, protecting recent messages by token budget.
    Replace old tool result content (>200 chars) with placeholder.
    
    Returns (pruned_messages, pruned_count)
    """
    _PRUNED_TOOL_PLACEHOLDER = "[Old tool output cleared to save context space]"
```

### 4.5 Iterative Summary Updates

**Location**: `agent/context_compressor.py:_update_summary()` (lines ~400-500)

**Mechanism**:
- Store `_previous_summary` from last compression
- On next compression, include previous summary in prompt
- LLM merges new turns into existing summary
- Preserves information across multiple compressions
- Prevents "summary of summary" degradation

---

## 5. TOOL DELEGATION & SUBAGENTS

### 5.1 Delegate Tool Architecture

**Location**: `tools/delegate_tool.py` (1,103 lines)

**Purpose**: Spawn isolated child agents for parallel workstreams

**Blocked Tools** (children never have access):
```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # no recursive delegation
    "clarify",         # no user interaction
    "memory",          # no writes to shared MEMORY.md
    "send_message",    # no cross-platform side effects
    "execute_code",    # children should reason step-by-step
])
```

### 5.2 Child Agent Spawning

**Location**: `tools/delegate_tool.py:_build_child_agent()` (lines ~238-350)

```python
def _build_child_agent(
    task_index: int,
    goal: str,
    context: Optional[str],
    toolsets: Optional[List[str]],
    model: Optional[str],
    max_iterations: int,
    parent_agent,
    override_provider: Optional[str] = None,
    override_base_url: Optional[str] = None,
    override_api_key: Optional[str] = None,
    override_api_mode: Optional[str] = None,
) -> AIAgent:
    """
    1. Build focused system prompt from goal + context
    2. Create fresh AIAgent with:
       - No parent history (fresh conversation)
       - Own task_id (isolated terminal session)
       - Restricted toolsets (configurable)
       - Blocked tools stripped
    3. Return configured agent
    """
```

### 5.3 Child System Prompt

**Location**: `tools/delegate_tool.py:_build_child_system_prompt()` (lines ~90-122)

```
You are a focused subagent working on a specific delegated task.

YOUR TASK:
[goal]

CONTEXT:
[context]

WORKSPACE PATH:
[workspace_path]

Complete this task using the tools available to you. When finished, provide:
- What you did
- What you found or accomplished
- Any files you created or modified
- Any issues encountered

Important: Never assume a repository lives at /workspace/... unless 
explicitly given. Discover the path first.
```

### 5.4 Parallel Execution & Batching

**Location**: `tools/delegate_tool.py:delegate_task()` (lines ~500-800)

**Single Task**:
```python
child = _build_child_agent(...)
result = child.run_conversation(goal, system_message=prompt)
return result["final_response"]
```

**Batch Mode** (parallel):
```python
max_concurrent = _get_max_concurrent_children()  # default 3
with ThreadPoolExecutor(max_workers=max_concurrent) as pool:
    futures = [
        pool.submit(_run_single_child, child, goal, prompt)
        for child in children
    ]
    results = [f.result() for f in as_completed(futures)]
```

### 5.5 Progress Callback & Display

**Location**: `tools/delegate_tool.py:_build_child_progress_callback()` (lines ~158-235)

**Two Display Paths**:
1. **CLI**: Print tree-view lines above parent's delegation spinner
2. **Gateway**: Batch tool names, relay to parent's progress callback

```python
def _callback(event_type: str, tool_name: str = None, preview: str = None, **kwargs):
    if event_type == "tool.started":
        # CLI: print_above(f" [1] ├─ ⚡ tool_name \"preview\"")
        # Gateway: batch tool names, flush every 5 tools
    elif event_type in ("_thinking", "reasoning.available"):
        # CLI: print_above(f" [1] ├─ 💭 \"reasoning\"")
        # Gateway: skip (too noisy)
```

### 5.6 Depth Limiting

**Location**: `tools/delegate_tool.py` (lines ~52-53)

```python
MAX_DEPTH = 2  # parent (0) -> child (1) -> grandchild rejected (2)
```

**Enforcement**:
- Parent agent: depth 0
- Child agent: depth 1 (can call delegate_task)
- Grandchild: depth 2 (delegate_task blocked)

---

## 6. MULTI-PLATFORM GATEWAY

### 6.1 Gateway Architecture

**Location**: `gateway/run.py` (8,836 lines)

**Single Process, Multiple Platforms**:
```
GatewayRunner
├── Telegram adapter (gateway/platforms/telegram.py)
├── Discord adapter (gateway/platforms/discord.py)
├── Slack adapter (gateway/platforms/slack.py)
├── WhatsApp adapter (gateway/platforms/whatsapp.py)
├── Signal adapter (gateway/platforms/signal.py)
├── Email adapter (gateway/platforms/email.py)
├── Matrix adapter (gateway/platforms/matrix.py)
├── Mattermost adapter (gateway/platforms/mattermost.py)
├── Feishu adapter (gateway/platforms/feishu.py)
├── DingTalk adapter (gateway/platforms/dingtalk.py)
├── Home Assistant adapter (gateway/platforms/homeassistant.py)
└── API Server (gateway/platforms/api_server.py)
```

### 6.2 Platform Adapter Base Class

**Location**: `gateway/platforms/base.py` (79,468 bytes)

**Interface**:
```python
class PlatformAdapter(ABC):
    async def connect(self) -> None:
        """Establish connection to platform."""
    
    async def disconnect(self) -> None:
        """Gracefully disconnect."""
    
    async def send_message(self, user_id: str, message: str, 
                          thread_id: str = None) -> None:
        """Send message to user."""
    
    async def handle_incoming_message(self, event: MessageEvent) -> None:
        """Process incoming message, route to agent."""
    
    async def start(self) -> None:
        """Main event loop."""
```

### 6.3 Session Persistence

**Location**: `gateway/session.py` (lines ~1-300)

**Per-User Sessions**:
```python
class SessionStore:
    def get_or_create_session(self, user_id: str, platform: str) -> Session:
        """
        1. Check if user has active session
        2. If not, create new session with:
           - user_id + platform key
           - Empty message history
           - Default model from config
        3. Return session
        """
```

**Session Persistence**:
- Stored in `hermes_state.db` (SQLite)
- Survives gateway restart
- Per-user conversation continuity

### 6.4 Message Dispatch Loop

**Location**: `gateway/run.py:GatewayRunner.handle_message()` (lines ~2000-2500)

```python
async def handle_message(self, event: MessageEvent) -> None:
    """
    1. Resolve or create session for user
    2. Parse slash commands (shared with CLI)
    3. If command:
       - Route to command handler (e.g., /model, /skills, /compress)
    4. Else:
       - Create AIAgent with session history
       - Call agent.run_conversation(user_message)
       - Stream response to platform
       - Persist session
    """
```

### 6.5 Slash Command Routing

**Location**: `hermes_cli/commands.py` (central registry)

**Shared Registry**:
```python
COMMAND_REGISTRY = [
    CommandDef("model", "Switch LLM model", "Configuration", aliases=("m",)),
    CommandDef("skills", "Browse and manage skills", "Tools & Skills"),
    CommandDef("compress", "Compress context", "Session"),
    CommandDef("new", "Start fresh conversation", "Session"),
    CommandDef("retry", "Retry last turn", "Session"),
    # ... 30+ commands
]
```

**Dispatch**:
- **CLI** (`cli.py`): `process_command()` resolves aliases, dispatches
- **Gateway** (`gateway/run.py`): Same `resolve_command()`, same handlers
- **Telegram**: `telegram_bot_commands()` generates BotCommand menu
- **Slack**: `slack_subcommand_map()` generates `/hermes` routing
- **Autocomplete**: `SlashCommandCompleter` feeds from registry

### 6.6 Platform-Specific Adapters

**Telegram** (`gateway/platforms/telegram.py`):
- Uses `python-telegram-bot` library
- Handles voice memo transcription
- DM pairing for security
- Token lock to prevent multiple profiles using same bot token

**Discord** (`gateway/platforms/discord.py`):
- Uses `discord.py` library
- Thread support for conversation continuity
- Reaction-based controls (✅ approve, ❌ deny)

**Slack** (`gateway/platforms/slack.py`):
- Uses `slack-sdk` library
- Thread replies for conversation context
- Slash command integration

---

## 7. PROFILE SYSTEM (Multi-Instance Isolation)

### 7.1 Profile Architecture

**Location**: `hermes_cli/main.py:_apply_profile_override()` (lines ~83-138)

**Design**:
- Each profile = separate `HERMES_HOME` directory
- `~/.hermes/profiles/<name>/` structure
- Fully isolated: config, API keys, memory, sessions, skills, gateway

**Profile Resolution**:
```python
def _apply_profile_override() -> None:
    """Pre-parse --profile/-p and set HERMES_HOME before module imports."""
    # 1. Check for explicit -p / --profile flag
    # 2. If no flag, check ~/.hermes/active_profile for sticky default
    # 3. If found, resolve profile path and set HERMES_HOME env var
    # 4. Strip flag from sys.argv so argparse doesn't see it
```

### 7.2 Profile-Safe Code Patterns

**Location**: `hermes_constants.py` (lines ~1-100)

**Two Functions**:
```python
def get_hermes_home() -> Path:
    """Return HERMES_HOME env var or default ~/.hermes"""
    return Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes")))

def display_hermes_home() -> str:
    """Return user-facing path (shows profiles/<name> for non-default)"""
    home = get_hermes_home()
    if "profiles" in str(home):
        return f"~/.hermes/profiles/{home.name}"
    return "~/.hermes"
```

**Rule**: Use `get_hermes_home()` for all file I/O, `display_hermes_home()` for user messages

### 7.3 Profile Operations

**Location**: `hermes_cli/profiles.py` (lines ~1-500)

```python
def resolve_profile_env(profile_name: str) -> str:
    """Resolve profile name to HERMES_HOME path."""
    if profile_name == "default":
        return str(Path.home() / ".hermes")
    profiles_root = Path.home() / ".hermes" / "profiles"
    profile_path = profiles_root / profile_name
    if not profile_path.exists():
        raise FileNotFoundError(f"Profile '{profile_name}' not found")
    return str(profile_path)

def list_profiles() -> List[str]:
    """List all available profiles."""
    profiles_root = Path.home() / ".hermes" / "profiles"
    return [p.name for p in profiles_root.iterdir() if p.is_dir()]

def create_profile(name: str) -> None:
    """Create new profile with default config."""
    profile_path = Path.home() / ".hermes" / "profiles" / name
    profile_path.mkdir(parents=True, exist_ok=True)
    # Copy default config, create subdirs
```

### 7.4 Gateway Token Locking

**Location**: `gateway/status.py` (lines ~1-200)

**Pattern** (Telegram example):
```python
async def connect(self) -> None:
    # Acquire scoped lock for this bot token
    from gateway.status import acquire_scoped_lock, release_scoped_lock
    self._lock_id = acquire_scoped_lock(f"telegram:{self.bot_token}")
    
    # ... connect to Telegram ...

async def disconnect(self) -> None:
    # Release lock
    release_scoped_lock(self._lock_id)
```

**Purpose**: Prevent two profiles from using the same credential simultaneously

---

## 8. MCP INTEGRATION

### 8.1 MCP Client Architecture

**Location**: `tools/mcp_tool.py` (2,195 lines)

**Design**:
- Dedicated background event loop (`_mcp_loop`) in daemon thread
- Each MCP server runs as long-lived asyncio Task
- Tool calls scheduled via `run_coroutine_threadsafe()`
- Thread-safe with `_lock` protecting mutations

**Transports**:
1. **Stdio** (`StdioServerParameters`): `command + args`
2. **HTTP/StreamableHTTP**: `url` with optional headers

### 8.2 MCP Configuration

**Location**: `config.yaml` example

```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    env: {}
    timeout: 120         # per-tool-call timeout
    connect_timeout: 60  # initial connection timeout
  
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_..."
  
  remote_api:
    url: "https://my-mcp-server.example.com/mcp"
    headers:
      Authorization: "Bearer sk-..."
    timeout: 180
  
  analysis:
    command: "npx"
    args: ["-y", "analysis-server"]
    sampling:                    # server-initiated LLM requests
      enabled: true
      model: "gemini-3-flash"    # override model
      max_tokens_cap: 4096
      timeout: 30
      max_rpm: 10
      allowed_models: []         # empty = all
      max_tool_rounds: 5
      log_level: "info"
```

### 8.3 Tool Discovery & Registration

**Location**: `tools/mcp_tool.py:discover_mcp_tools()` (lines ~1800-2000)

```python
def discover_mcp_tools() -> None:
    """
    1. Load MCP servers from config.yaml
    2. For each server:
       a. Connect via stdio or HTTP
       b. Call tools/list
       c. Register each tool in registry
       d. Set up notification handler for dynamic discovery
    """
```

**Dynamic Discovery**:
- MCP servers can send `notifications/tools/list_changed`
- Hermes deregisters old tools, discovers new ones
- No restart needed

### 8.4 Sampling Support (Server-Initiated LLM Calls)

**Location**: `tools/mcp_tool.py:_handle_sampling_request()` (lines ~1400-1600)

**Flow**:
```
MCP Server → sampling/createMessage request
           → Hermes calls auxiliary LLM
           → Return text or tool-use response
           → Server continues execution
```

**Configuration**:
```yaml
sampling:
  enabled: true
  model: "gemini-3-flash"    # override default auxiliary model
  max_tokens_cap: 4096
  timeout: 30
  max_rpm: 10                # rate limit
  allowed_models: []         # whitelist (empty = all)
  max_tool_rounds: 5         # tool loop limit
  log_level: "info"          # audit verbosity
```

### 8.5 Security & Credential Handling

**Location**: `tools/mcp_tool.py:_build_safe_env()` (lines ~192-208)

**Environment Filtering**:
```python
_SAFE_ENV_KEYS = frozenset({
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
})

def _build_safe_env(user_env: Optional[dict]) -> dict:
    """
    Only pass through safe baseline variables + XDG_* + user-specified.
    Prevents accidental credential leakage to MCP subprocesses.
    """
```

**Credential Stripping**:
```python
_CREDENTIAL_PATTERN = re.compile(
    r"(?:"
    r"ghp_[A-Za-z0-9_]{1,255}"           # GitHub PAT
    r"|sk-[A-Za-z0-9_]{1,255}"           # OpenAI-style key
    r"|Bearer\s+\S+"                      # Bearer token
    r"|token=[^\s&,;\"']{1,255}"         # token=...
    r")",
    re.IGNORECASE,
)

def _sanitize_error(text: str) -> str:
    """Strip credential-like patterns before returning to LLM."""
    return _CREDENTIAL_PATTERN.sub("[REDACTED]", text)
```

---

## 9. AUXILIARY LLM CLIENT

### 9.1 Purpose & Architecture

**Location**: `agent/auxiliary_client.py` (lines ~1-300)

**Used For**:
- Vision analysis (image understanding)
- Web extraction (summarization)
- Context compression (summarization)
- Approval decisions (command safety)
- MCP sampling (server-initiated LLM calls)

**Configuration** (`config.yaml`):
```yaml
auxiliary:
  vision:
    provider: "auto"           # auto-detect or override
    model: "gpt-4-vision"      # override model
    base_url: "..."            # override endpoint
    api_key: "..."             # override credentials
  
  web_extract:
    provider: "auto"
    model: "gpt-4-turbo"
    # ...
  
  approval:
    provider: "auto"
    model: "claude-opus"
    # ...
```

### 9.2 Provider Resolution

**Location**: `agent/auxiliary_client.py:call_llm()` (lines ~50-150)

```python
def call_llm(
    prompt: str,
    task: str = "vision",      # "vision", "web_extract", "approval"
    max_tokens: int = 2000,
    temperature: float = 0.3,
) -> str:
    """
    1. Resolve provider from config (task-specific override)
    2. Get credentials from auth system
    3. Call LLM with prompt
    4. Return response text
    """
```

---

## 10. TOOL REGISTRY & DISCOVERY

### 10.1 Registry Architecture

**Location**: `tools/registry.py` (335 lines)

**Singleton Pattern**:
```python
class ToolRegistry:
    def __init__(self):
        self._tools: Dict[str, ToolEntry] = {}
        self._toolset_checks: Dict[str, Callable] = {}
    
    def register(self, name, toolset, schema, handler, check_fn, ...):
        """Called at module-import time by each tool file."""
    
    def dispatch(self, name: str, args: dict, **kwargs) -> str:
        """Execute tool handler, bridge async, catch exceptions."""
    
    def get_definitions(self, tool_names: Set[str]) -> List[dict]:
        """Return OpenAI-format schemas for requested tools."""
```

### 10.2 Tool Discovery Pipeline

**Location**: `model_tools.py:_discover_tools()` (lines ~132-170)

```python
def _discover_tools():
    """Import all tool modules to trigger registry.register() calls."""
    _modules = [
        "tools.web_tools",
        "tools.terminal_tool",
        "tools.file_tools",
        "tools.vision_tools",
        "tools.browser_tool",
        "tools.code_execution_tool",
        "tools.delegate_tool",
        "tools.memory_tool",
        "tools.session_search_tool",
        "tools.skills_tool",
        "tools.skill_manager_tool",
        # ... 30+ more
    ]
    for mod_name in _modules:
        try:
            importlib.import_module(mod_name)
        except Exception as e:
            logger.warning("Could not import %s: %s", mod_name, e)

_discover_tools()

# MCP tool discovery (external MCP servers)
try:
    from tools.mcp_tool import discover_mcp_tools
    discover_mcp_tools()
except Exception as e:
    logger.debug("MCP discovery failed: %s", e)

# Plugin tool discovery (user/project/pip plugins)
try:
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
except Exception as e:
    logger.debug("Plugin discovery failed: %s", e)
```

### 10.3 Tool Availability Checking

**Location**: `tools/registry.py:get_definitions()` (lines ~116-143)

```python
def get_definitions(self, tool_names: Set[str], quiet: bool = False) -> List[dict]:
    """Return OpenAI-format tool schemas for requested tool names.
    
    Only tools whose check_fn() returns True (or have no check_fn)
    are included.
    """
    result = []
    check_results: Dict[Callable, bool] = {}
    for name in sorted(tool_names):
        entry = self._tools.get(name)
        if not entry:
            continue
        if entry.check_fn:
            if entry.check_fn not in check_results:
                try:
                    check_results[entry.check_fn] = bool(entry.check_fn())
                except Exception:
                    check_results[entry.check_fn] = False
            if not check_results[entry.check_fn]:
                continue
        schema_with_name = {**entry.schema, "name": entry.name}
        result.append({"type": "function", "function": schema_with_name})
    return result
```

---

## 11. PROMPT CACHING (Anthropic)

### 11.1 Prompt Caching Integration

**Location**: `agent/prompt_caching.py` (lines ~1-300)

**Purpose**: Reduce costs for repeated system prompts (skills, context files, memory)

**Mechanism**:
```python
def apply_anthropic_cache_control(messages: List[dict], model: str) -> List[dict]:
    """
    Add cache_control: {"type": "ephemeral"} to the last system message.
    
    Hermes ensures caching remains valid throughout a conversation:
    - Never alter past context mid-conversation
    - Never change toolsets mid-conversation
    - Never reload memories or rebuild system prompts mid-conversation
    
    Cache-breaking forces dramatically higher costs.
    """
```

**Cache Invalidation**:
- `/model` switch → new cache (different model)
- `/compress` → new cache (system prompt changed)
- `/new` → new cache (fresh session)

---

## 12. EXECUTION FLOW DIAGRAM

```
User Input
    ↓
[CLI / Gateway Platform Adapter]
    ↓
[Session Resolution / Creation]
    ↓
[AIAgent.run_conversation()]
    ├─ Build system prompt:
    │  ├─ DEFAULT_AGENT_IDENTITY
    │  ├─ Memory context (prefetch_all)
    │  ├─ Skills (inject as user message)
    │  ├─ Context files (AGENTS.md, etc.)
    │  ├─ Compression summary (if needed)
    │  └─ Anthropic cache control
    │
    ├─ LLM API call (with tool schemas)
    │
    ├─ If tool_calls:
    │  ├─ Parallelize if safe
    │  ├─ For each tool:
    │  │  ├─ Route to memory manager (if memory tool)
    │  │  ├─ Route to registry.dispatch() (all others)
    │  │  ├─ Enforce result size limits
    │  │  └─ Append tool result to messages
    │  │
    │  └─ Loop back to LLM API call
    │
    ├─ Else (no tool_calls):
    │  ├─ Return response.content
    │  ├─ Sync turn to memory (sync_all)
    │  ├─ Queue background prefetch (queue_prefetch_all)
    │  └─ Persist session to DB
    │
    └─ Check compression threshold
       └─ If needed: compress context, update summary

[Response to User]
```

---

## 13. KEY DESIGN PATTERNS

### 13.1 Namespace Exports (Not Used Here)
Hermes uses direct imports, not namespace exports like OpenOmni.

### 13.2 Zod-First Types (Not Used Here)
Hermes uses Python dataclasses + Pydantic, not Zod.

### 13.3 Discriminated Unions
Used for message roles, event types, etc.

### 13.4 Registry Pattern
Central `ToolRegistry` singleton for tool discovery + dispatch.

### 13.5 Provider Pattern
Memory providers, LLM providers, platform adapters all follow provider interface.

### 13.6 Callback Pattern
Tool progress callbacks for CLI spinner + gateway relay.

---

## 14. REUSABLE PATTERNS FOR OPENOMNI

### 14.1 Skill System
- **Applicable**: OpenOmni could adopt SKILL.md format for procedural memory
- **Key Insight**: Progressive disclosure (metadata → full content → linked files) reduces token usage
- **Implementation**: Scan `~/.openomni/skills/`, inject as user message (preserves prompt caching)

### 14.2 Context Compression
- **Applicable**: OpenOmni's Plan/Team mode could use 4-stage compression
- **Key Insight**: Iterative summary updates preserve information across compressions
- **Implementation**: Protect head + tail by token budget, summarize middle with structured prompt

### 14.3 Tool Delegation
- **Applicable**: OpenOmni's subagent system could adopt Hermes' parallel execution + progress callbacks
- **Key Insight**: Isolated context + restricted toolsets + depth limiting prevents runaway delegation
- **Implementation**: ThreadPoolExecutor with max_concurrent_children, progress relay to parent

### 14.4 Memory Prefetch/Sync Cycle
- **Applicable**: OpenOmni could adopt pre-turn prefetch + post-turn sync pattern
- **Key Insight**: Fenced memory blocks prevent model treating recalled context as user input
- **Implementation**: `<memory-context>` tags, system note, sanitization

### 14.5 Profile System
- **Applicable**: OpenOmni could support multi-instance isolation via HERMES_HOME pattern
- **Key Insight**: Pre-parse profile flag before module imports, set env var early
- **Implementation**: `_apply_profile_override()` in main.py, use `get_hermes_home()` everywhere

### 14.6 MCP Integration
- **Applicable**: OpenOmni already has MCP support; Hermes' sampling + dynamic discovery are advanced
- **Key Insight**: Dedicated background event loop + thread-safe scheduling prevents blocking
- **Implementation**: `run_coroutine_threadsafe()` for tool calls, notification handlers for dynamic discovery

### 14.7 Parallel Tool Execution
- **Applicable**: OpenOmni could adopt Hermes' path-scoped locking for file tools
- **Key Insight**: Detect overlapping paths, fall back to sequential if conflict
- **Implementation**: `_should_parallelize_tool_batch()`, `_PATH_SCOPED_TOOLS`, `_MAX_TOOL_WORKERS`

### 14.8 Auxiliary LLM Client
- **Applicable**: OpenOmni could adopt task-specific provider overrides
- **Key Insight**: Separate cheap/fast model for vision, web extraction, approval
- **Implementation**: `auxiliary.vision.model`, `auxiliary.web_extract.model`, etc. in config

---

## 15. IMPLEMENTATION DETAILS NOT COVERED

- **Cron Scheduler** (`cron/`): Scheduled tasks with platform delivery
- **RL Training** (`environments/`, `trajectory_compressor.py`): Atropos integration
- **Voice Mode** (`tools/voice_mode.py`): Voice memo transcription + TTS
- **Browser Automation** (`tools/browser_tool.py`): Browserbase, Firecrawl, Browser Use
- **Terminal Backends** (`tools/environments/`): Local, Docker, SSH, Modal, Daytona, Singularity
- **Approval Gate** (`tools/approval.py`): Dangerous command detection + user approval
- **Honcho Integration** (`plugins/memory/honcho/`): Dialectic user modeling
- **ACP Server** (`acp_adapter/`): VS Code / Zed / JetBrains integration

---

## 16. GITHUB PERMALINKS (Key Files)

| Component | File | Lines | Permalink |
|-----------|------|-------|-----------|
| Agent Loop | `run_agent.py` | 1-300 | https://github.com/NousResearch/hermes-agent/blob/main/run_agent.py#L1-L300 |
| Tool Registry | `tools/registry.py` | 1-200 | https://github.com/NousResearch/hermes-agent/blob/main/tools/registry.py#L1-L200 |
| Context Compressor | `agent/context_compressor.py` | 1-250 | https://github.com/NousResearch/hermes-agent/blob/main/agent/context_compressor.py#L1-L250 |
| Memory Manager | `agent/memory_manager.py` | 1-250 | https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py#L1-L250 |
| Skill System | `tools/skills_tool.py` | 1-200 | https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py#L1-L200 |
| Delegation | `tools/delegate_tool.py` | 1-250 | https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool.py#L1-L250 |
| Gateway | `gateway/run.py` | 1-200 | https://github.com/NousResearch/hermes-agent/blob/main/gateway/run.py#L1-L200 |
| MCP Client | `tools/mcp_tool.py` | 1-250 | https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool.py#L1-L250 |
| Session DB | `hermes_state.py` | 1-200 | https://github.com/NousResearch/hermes-agent/blob/main/hermes_state.py#L1-L200 |
| Profile System | `hermes_cli/main.py` | 83-138 | https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/main.py#L83-L138 |

---

## 17. CONCLUSION

Hermes Agent is a **production-grade, self-improving agent framework** with:

1. **Closed-loop learning**: Skills created autonomously, improved during use
2. **Sophisticated context management**: 4-stage compression with iterative summaries
3. **Parallel execution**: Safe tool parallelization with path-scoped locking
4. **Multi-platform**: Single process serving 11+ messaging platforms
5. **Extensible**: MCP servers, memory plugins, custom tools, profiles
6. **Enterprise-ready**: Session persistence, cost tracking, approval gates, security

**For OpenOmni**: The most valuable patterns are:
- **Skill system** (progressive disclosure, autonomous creation)
- **Context compression** (iterative summaries, token budgets)
- **Tool delegation** (isolated context, parallel execution, progress relay)
- **Memory prefetch/sync** (fenced blocks, provider abstraction)
- **Profile system** (multi-instance isolation via env var)

