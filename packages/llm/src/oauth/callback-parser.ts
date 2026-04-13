export type CallbackParams = { code: string; state: string };

export function parseCallbackInput(input: string): CallbackParams | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return { code, state };
  } catch {
    // not a URL, try other formats
  }

  const hashParts = trimmed.split("#");
  if (hashParts.length === 2 && hashParts[0] && hashParts[1]) {
    return { code: hashParts[0], state: hashParts[1] };
  }

  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");
  if (code && state) return { code, state };

  return null;
}

export function parseCallbackWithStateValidation(
  input: string,
  expectedState: string,
): CallbackParams | null {
  const result = parseCallbackInput(input);
  if (!result) return null;
  if (result.state !== expectedState) return null;
  return result;
}
