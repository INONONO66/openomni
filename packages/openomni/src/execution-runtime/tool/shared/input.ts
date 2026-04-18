export type InputRecord = Record<string, unknown>;

export function requireString(input: InputRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(input: InputRecord, key: string): string | undefined {
  return input[key] === undefined ? undefined : requireString(input, key);
}

export function optionalBoolean(input: InputRecord, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid input: ${key} must be a boolean`);
  }
  return value;
}

export function optionalPositiveInteger(input: InputRecord, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid input: ${key} must be a positive integer`);
  }
  return value;
}

export function optionalPositiveNumber(input: InputRecord, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid input: ${key} must be a positive number`);
  }
  return value;
}
