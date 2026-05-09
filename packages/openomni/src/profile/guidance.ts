export const MEMORY_GUIDANCE = `
Memory entries must be declarative facts, not instructions.

Good: "User prefers concise responses"
Good: "User's primary language is Korean"
Good: "Project uses Bun runtime instead of Node"
Bad:  "Always respond concisely"
Bad:  "Use Korean when talking to user"

What to save:
- User corrections and explicit preferences (highest value)
- Stable personal context (name, role, timezone, tools)
- Project-specific facts the user has shared

What NOT to save:
- Task progress or session outcomes
- Completed-work logs or TODO state
- Procedures, workflows, or step-by-step instructions
- Anything that changes between sessions
`.trim();
