export const BASH_PROMPT = `Executes a bash command and returns its combined stdout and stderr output.

Commands run through \`bash -lc\`, so the user login shell environment (PATH, aliases, rc scripts) is available. Shell state does not persist between calls — every invocation starts a fresh shell.

# Working directory
- Every command runs inside the workspace root. Use the \`workdir\` parameter to run in a subdirectory, specified either relative to the workspace root or as an absolute path that resolves inside it.
- Workdir values that resolve outside the workspace root are rejected before the command runs. \`cd\` inside the command itself is allowed but has no effect on the next call.
- Prefer absolute paths inside the workspace over \`cd\` chains when you need to operate on different directories across calls.

# Timeout
- Commands time out after 120000ms (2 minutes) by default. You may raise this up to 600000ms (10 minutes) with the \`timeoutMs\` parameter for long-running operations such as test suites or installs.
- When a command is killed by the timeout, the tool returns the partial output with \`isError: true\` and a note about the timeout.

# Git safety
- Read-only inspection commands (\`git status\`, \`git log\`, \`git diff\`, \`git show\`, \`git branch\`, \`git remote -v\`, \`git describe\`, \`git tag\`, \`git ls-files\`) are safe to run freely.
- Destructive operations (\`git push\`, \`git reset --hard\`, \`git clean -f\`, \`git rebase -i\`, force pushes) require explicit user intent. Do not run them speculatively.
- Never skip hooks (\`--no-verify\`, \`--no-gpg-sign\`, \`-c commit.gpgsign=false\`) unless the user has explicitly asked. If a pre-commit hook fails, fix the underlying issue and make a new commit.
- Prefer creating new commits over \`git commit --amend\` unless the user has explicitly requested an amend.
- When staging, prefer naming specific files over \`git add -A\` or \`git add .\` so you do not accidentally include secrets (.env, credentials.json) or large binaries.

# Destructive shell operations
- \`rm -rf\` / \`rm -r\`, \`mv\`, and \`chmod\` change or delete files in ways that cannot be undone. Double-check the target path and prefer dedicated tools (\`write\`, editor tools) when available.
- Never run destructive commands against paths you did not create in the current workflow or against paths outside the current worktree.

# Avoid busy waiting and sleep loops
- Do not insert \`sleep\` between commands that can run back-to-back — just issue the next command.
- Do not retry a failing command inside a \`while true; do ...; sleep N; done\` loop. Diagnose the root cause instead.
- If you genuinely need to wait for an external system, issue a single concrete check command (\`gh run view\`, \`curl -fsSL\`, \`kubectl get\`) rather than polling in a sleep loop.
- Keep any unavoidable sleep short (1-5 seconds).

# Output handling
- stdout and stderr are concatenated and trimmed. On non-zero exit, \`isError: true\` is set and the combined output is returned so you can diagnose the failure.
- Long outputs should be narrowed with \`head\`, \`tail\`, \`wc\`, \`grep\`, or \`jq\` inside the command itself to avoid overwhelming the context window.

# When not to use this tool
- Reading, writing, listing, or searching files: use the dedicated file tools, which stream content more efficiently and produce better diffs.
- Fetching web pages or documentation: use the appropriate MCP tool.
- Use \`bash\` only when no dedicated tool covers the task, or when composing shell utilities is clearly the most direct path.`;
