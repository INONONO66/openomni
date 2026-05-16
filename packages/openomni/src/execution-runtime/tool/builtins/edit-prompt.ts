export const EDIT_PROMPT = `Replace an exact substring in a file within the workspace.
oldString must already exist in the file and must differ from newString.
Default behavior replaces the first occurrence; set replaceAll=true to replace every match.
Set expectedFileHash to the current file SHA-256 hash to reject stale edits.`;
