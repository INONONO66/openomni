import { isProxy } from "node:util/types";
import { isRegisteredSecretHandle } from "./secret-registry";

const REDACTED = "[REDACTED]";
const HANDLE_REDACTED = "[REDACTED:SECRET_HANDLE]";
const CIRCULAR = "[SANITIZED:CIRCULAR]";
const MAX_DEPTH = "[SANITIZED:MAX_DEPTH]";
const TRUNCATED = "[SANITIZED:TRUNCATED]";
const ACCESSOR = "[SANITIZED:ACCESSOR]";
const UNSUPPORTED = "[SANITIZED:UNSUPPORTED]";
const SERIALIZATION_FAILURE = "[SANITIZED:SERIALIZATION_FAILURE]";
const MAX_DEPTH_VALUE = 12;
const MAX_ITEMS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder(undefined, { fatal: true });
const REDACTED_BYTES = encoder.encode(REDACTED);
const SANITIZED_BRAND: unique symbol = Symbol("BoundarySanitizer.Sanitized");

export type SanitizedText = string & { readonly [SANITIZED_BRAND]: true };
export type SanitizedError = Error & { readonly [SANITIZED_BRAND]: true };
export interface SanitizedArray extends ReadonlyArray<SanitizedValue> {}
export interface SanitizedRecord {
  readonly [key: string]: SanitizedValue;
}
export type SanitizedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | SanitizedError
  | SanitizedArray
  | SanitizedRecord;

export class BoundarySanitizerError extends Error {
  readonly code: "DISPOSED";

  constructor() {
    super("BoundarySanitizer is disposed");
    this.name = "BoundarySanitizerError";
    this.code = "DISPOSED";
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  if (left.byteLength !== right.byteLength) return right.byteLength - left.byteLength;
  for (let index = 0; index < left.byteLength; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

function matchesAt(input: Uint8Array, needle: Uint8Array, offset: number): boolean {
  if (offset + needle.byteLength > input.byteLength) return false;
  for (let index = 0; index < needle.byteLength; index += 1) {
    if (input[offset + index] !== needle[index]) return false;
  }
  return true;
}

function replaceBytes(input: Uint8Array, needles: readonly Uint8Array[]): Uint8Array {
  const output: number[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    const needle = needles.find((candidate) => matchesAt(input, candidate, offset));
    if (needle) {
      output.push(...REDACTED_BYTES);
      offset += needle.byteLength;
    } else {
      output.push(input[offset] as number);
      offset += 1;
    }
  }
  return Uint8Array.from(output);
}

function hexByte(input: Uint8Array, offset: number): number | undefined {
  if (input[offset] !== 0x25 || offset + 2 >= input.byteLength) return undefined;
  const encoded = String.fromCharCode(input[offset + 1] as number, input[offset + 2] as number);
  return /^[0-9a-f]{2}$/iu.test(encoded) ? Number.parseInt(encoded, 16) : undefined;
}

function encodedByteMatchEnd(
  input: Uint8Array,
  needle: Uint8Array,
  offset: number,
): number | undefined {
  let sourceOffset = offset;
  for (const expected of needle) {
    const encoded = hexByte(input, sourceOffset);
    if ((encoded ?? input[sourceOffset]) !== expected) return undefined;
    sourceOffset += encoded === undefined ? 1 : 3;
  }
  return sourceOffset;
}

function replaceEncodedBytes(input: Uint8Array, needles: readonly Uint8Array[]): Uint8Array {
  const output: number[] = [];
  for (let offset = 0; offset < input.byteLength; ) {
    let matchEnd: number | undefined;
    for (const needle of needles) {
      matchEnd = encodedByteMatchEnd(input, needle, offset);
      if (matchEnd !== undefined) break;
    }
    if (matchEnd === undefined) {
      output.push(input[offset] as number);
      offset += 1;
    } else {
      output.push(...REDACTED_BYTES);
      offset = matchEnd;
    }
  }
  return Uint8Array.from(output);
}
function base64Forms(bytes: Uint8Array): readonly string[] {
  const copy = Buffer.from(bytes);
  try {
    const standard = copy.toString("base64");
    const unpadded = standard.replace(/=+$/u, "");
    const url = standard.split("+").join("-").split("/").join("_");
    return [standard, unpadded, url, url.replace(/=+$/u, "")];
  } finally {
    copy.fill(0);
  }
}

type EncodedByte = Readonly<{
  value: number;
  start: number;
  end: number;
  first: boolean;
  last: boolean;
}>;

function decodedSecret(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function secretForms(secret: string | Uint8Array, bytes: Uint8Array): readonly string[] {
  const text = typeof secret === "string" ? secret : decodedSecret(bytes);
  return [
    ...(text === undefined ? [] : [text, JSON.stringify(text).slice(1, -1)]),
    ...base64Forms(bytes),
  ];
}

function encodedBytes(value: string): readonly EncodedByte[] {
  const output: EncodedByte[] = [];
  for (let offset = 0; offset < value.length; ) {
    const encoded = value.slice(offset, offset + 3);
    if (/^%[0-9a-f]{2}$/iu.test(encoded)) {
      output.push({
        value: Number.parseInt(encoded.slice(1), 16),
        start: offset,
        end: offset + 3,
        first: true,
        last: true,
      });
      offset += 3;
      continue;
    }
    const codePoint = value.codePointAt(offset);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const end = offset + width;
    const bytes = encoder.encode(value.slice(offset, end));
    for (let index = 0; index < bytes.byteLength; index += 1) {
      output.push({
        value: bytes[index] as number,
        start: offset,
        end,
        first: index === 0,
        last: index === bytes.byteLength - 1,
      });
    }
    offset = end;
  }
  return output;
}

function encodedMatchAt(
  input: readonly EncodedByte[],
  needle: Uint8Array,
  offset: number,
): boolean {
  if (!input[offset]?.first || offset + needle.byteLength > input.length) return false;
  for (let index = 0; index < needle.byteLength; index += 1) {
    if (input[offset + index]?.value !== needle[index]) return false;
  }
  return input[offset + needle.byteLength - 1]?.last === true;
}

function redactEncodedForms(value: string, needles: readonly Uint8Array[]): string {
  const input = encodedBytes(value);
  let output = "";
  let sourceOffset = 0;
  for (let offset = 0; offset < input.length; ) {
    const needle = needles.find((candidate) => encodedMatchAt(input, candidate, offset));
    if (!needle) {
      offset += 1;
      continue;
    }
    const start = input[offset]?.start as number;
    const end = input[offset + needle.byteLength - 1]?.end as number;
    output += value.slice(sourceOffset, start) + REDACTED;
    sourceOffset = end;
    offset += needle.byteLength;
    while (offset < input.length && (input[offset]?.start as number) < sourceOffset) {
      offset += 1;
    }
  }
  return output + value.slice(sourceOffset);
}

/** Checks exact raw, escaped, base64, and fully or partially percent-encoded secret forms. */
export function containsExactSecretForm(value: string, secret: string | Uint8Array): boolean {
  if (typeof secret === "string") {
    try {
      encodeURIComponent(secret);
    } catch {
      throw new Error("secret text cannot be URI encoded");
    }
  }
  const bytes = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
  const forms = secretForms(secret, bytes).filter((form) => form.length > 0);
  const encodedForms = forms.map((form) => encoder.encode(form));
  try {
    if (bytes.byteLength === 0) return false;
    if (forms.some((form) => value.includes(form))) return true;
    return redactEncodedForms(value, [bytes, ...encodedForms].sort(compareBytes)) !== value;
  } finally {
    bytes.fill(0);
    for (const form of encodedForms) form.fill(0);
  }
}

function dataProperty(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key];
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function defineData(target: object, key: string, value: SanitizedValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export class BoundarySanitizer {
  readonly #strings = new Set<string>();
  readonly #bytes: Uint8Array[] = [];
  readonly #encodedBytes: Uint8Array[] = [];
  #disposed = false;

  static create(): BoundarySanitizer {
    return new BoundarySanitizer();
  }

  /** Registry-only hook. Copies all forms; it never retains the caller's buffer. */
  registerExactSecret(secret: string | Uint8Array): void {
    this.#assertActive();
    const bytes = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
    try {
      if (bytes.byteLength === 0) return;
      this.#encodedBytes.push(new Uint8Array(bytes));
      this.#bytes.push(new Uint8Array(bytes));
      for (const form of new Set(secretForms(secret, bytes))) {
        if (form.length === 0) continue;
        if (!this.#strings.has(form)) {
          this.#strings.add(form);
          this.#bytes.push(encoder.encode(form));
          this.#encodedBytes.push(encoder.encode(form));
        }
      }
      this.#encodedBytes.sort(compareBytes);
      this.#bytes.sort(compareBytes);
    } finally {
      bytes.fill(0);
    }
  }

  /** Internal lifecycle check used by the registry that shares this sanitizer. */
  assertActive(): void {
    this.#assertActive();
  }

  sanitizeText(_boundary: string, value: string): SanitizedText {
    this.#assertActive();
    return this.#redactText(value) as SanitizedText;
  }

  sanitizeError(boundary: string, value: unknown): SanitizedError {
    this.#assertActive();
    const sanitized = this.sanitizeValue(boundary, value);
    if (sanitized instanceof Error) return sanitized as SanitizedError;
    return new Error(
      typeof sanitized === "string" ? sanitized : SERIALIZATION_FAILURE,
    ) as SanitizedError;
  }

  sanitizeValue(_boundary: string, value: unknown): SanitizedValue {
    this.#assertActive();
    try {
      return this.#sanitize(value, new WeakSet<object>(), 0, { count: 0 });
    } catch {
      return SERIALIZATION_FAILURE;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const bytes of this.#bytes) bytes.fill(0);
    for (const bytes of this.#encodedBytes) bytes.fill(0);
    this.#bytes.length = 0;
    this.#encodedBytes.length = 0;
    this.#strings.clear();
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new BoundarySanitizerError();
  }

  #redactText(value: string): string {
    const secrets = [...this.#strings].sort(
      (left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0),
    );
    const encodedRedacted = redactEncodedForms(value, this.#encodedBytes);
    let output = "";
    let offset = 0;
    while (offset < encodedRedacted.length) {
      const secret = secrets.find((candidate) => encodedRedacted.startsWith(candidate, offset));
      if (secret) {
        output += REDACTED;
        offset += secret.length;
      } else {
        output += encodedRedacted[offset];
        offset += 1;
      }
    }
    return output;
  }

  #redactBytes(value: Uint8Array): Uint8Array {
    const encodedRedacted = replaceEncodedBytes(value, this.#encodedBytes);
    return replaceBytes(encodedRedacted, this.#bytes);
  }

  #sanitize(
    value: unknown,
    seen: WeakSet<object>,
    depth: number,
    budget: { count: number },
  ): SanitizedValue {
    if (budget.count >= MAX_ITEMS) return TRUNCATED;
    budget.count += 1;
    if (typeof value === "string") return this.#redactText(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : UNSUPPORTED;
    if (typeof value === "undefined") return undefined;
    if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function")
      return UNSUPPORTED;
    if (typeof value !== "object") return UNSUPPORTED;
    if (isProxy(value)) return SERIALIZATION_FAILURE;
    if (depth >= MAX_DEPTH_VALUE) return MAX_DEPTH;

    try {
      if (value instanceof Uint8Array) return this.#redactBytes(value);
      if (isRegisteredSecretHandle(value, this)) return HANDLE_REDACTED;
      if (seen.has(value)) return CIRCULAR;
      seen.add(value);

      if (value instanceof URL) return this.#redactText(URL.prototype.toString.call(value));
      if (typeof Headers !== "undefined" && value instanceof Headers) {
        const output = Object.create(null) as Record<string, SanitizedValue>;
        for (const [key, item] of Headers.prototype.entries.call(value) as IterableIterator<
          [string, string]
        >) {
          if (budget.count >= MAX_ITEMS) {
            defineData(output, TRUNCATED, TRUNCATED);
            break;
          }
          defineData(output, this.#redactText(key), this.#redactText(item));
          budget.count += 1;
        }
        return output;
      }

      if (value instanceof Error) {
        const ownKeys = Reflect.ownKeys(value);
        const ownKeyLimit = Math.max(0, MAX_ITEMS - budget.count);
        const ownKeysTruncated = ownKeys.length > ownKeyLimit;
        const descriptors: PropertyDescriptorMap = Object.create(null);
        for (const key of ["message", "name", "stack", "cause", "errors"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor !== undefined) descriptors[key] = descriptor;
        }
        const message = dataProperty(descriptors, "message");
        const name = dataProperty(descriptors, "name");
        const aggregate = name === "AggregateError" || descriptors.errors !== undefined;
        const sanitized = new Error(typeof message === "string" ? this.#redactText(message) : "");
        sanitized.name =
          typeof name === "string"
            ? this.#redactText(name)
            : aggregate
              ? "AggregateError"
              : "Error";
        const stack = dataProperty(descriptors, "stack");
        if (typeof stack === "string") sanitized.stack = this.#redactText(stack);
        const cause = descriptors.cause;
        if (cause)
          defineData(
            sanitized,
            "cause",
            "value" in cause ? this.#sanitize(cause.value, seen, depth + 1, budget) : ACCESSOR,
          );
        if (aggregate) {
          const errors = descriptors.errors;
          defineData(
            sanitized,
            "errors",
            errors && "value" in errors
              ? this.#sanitize(errors.value, seen, depth + 1, budget)
              : ACCESSOR,
          );
        }
        for (const key of ownKeys.slice(0, ownKeyLimit)) {
          if (typeof key === "symbol") continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined) continue;
          if (
            key === "message" ||
            key === "name" ||
            key === "stack" ||
            key === "cause" ||
            key === "errors"
          )
            continue;
          defineData(
            sanitized,
            this.#redactText(key),
            "value" in descriptor
              ? this.#sanitize(descriptor.value, seen, depth + 1, budget)
              : ACCESSOR,
          );
        }
        if (ownKeysTruncated) defineData(sanitized, TRUNCATED, TRUNCATED);
        return sanitized as SanitizedError;
      }

      if (Array.isArray(value)) {
        const output: SanitizedValue[] = [];
        const sourceLength = Object.getOwnPropertyDescriptor(value, "length")?.value;
        const arrayLength = typeof sourceLength === "number" ? sourceLength : 0;
        const length = Math.min(arrayLength, MAX_ITEMS - budget.count);
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          output.push(
            descriptor && "value" in descriptor
              ? this.#sanitize(descriptor.value, seen, depth + 1, budget)
              : ACCESSOR,
          );
        }
        if (length < arrayLength) output.push(TRUNCATED);
        return output;
      }

      let prototype: object | null;
      try {
        prototype = Object.getPrototypeOf(value);
      } catch {
        return SERIALIZATION_FAILURE;
      }
      if (prototype !== Object.prototype && prototype !== null) return UNSUPPORTED;
      const ownKeys = Reflect.ownKeys(value);
      const ownKeyLimit = Math.max(0, MAX_ITEMS - budget.count);
      const ownKeysTruncated = ownKeys.length > ownKeyLimit;
      const output = Object.create(null) as Record<string, SanitizedValue>;
      for (const key of ownKeys.slice(0, ownKeyLimit)) {
        if (typeof key === "symbol") {
          defineData(output, "[SANITIZED:SYMBOL_PROPERTY]", UNSUPPORTED);
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        defineData(
          output,
          this.#redactText(key),
          "value" in descriptor
            ? this.#sanitize(descriptor.value, seen, depth + 1, budget)
            : ACCESSOR,
        );
        if (budget.count >= MAX_ITEMS) {
          defineData(output, TRUNCATED, TRUNCATED);
          break;
        }
      }
      if (ownKeysTruncated) defineData(output, TRUNCATED, TRUNCATED);
      return output;
    } catch {
      return SERIALIZATION_FAILURE;
    }
  }
}
