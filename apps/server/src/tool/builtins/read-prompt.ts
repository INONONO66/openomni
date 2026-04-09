export const READ_PROMPT = `Read file contents or list a directory inside the workspace.
Files return line-prefixed text (1-indexed); directories return sorted entries with trailing slash for subdirectories.
Use offset and limit for paginated reads of large files. Paths must stay within the workspace root.`;
