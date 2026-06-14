import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ky from "ky";
import type { ReadBackHttpMethod } from "./read-back-request.js";

export type ReadBackHttpResult = {
  readonly statusCode: number | undefined;
  readonly body: string;
  readonly bodyDigest: string | undefined;
  readonly complete: boolean;
};

class DisallowedNetworkTargetError extends Error {
  constructor(address: string) {
    super(`read-back target resolves to a private network address: ${address}`);
    this.name = "DisallowedNetworkTargetError";
  }
}

export async function loadReadBackUrl(
  target: string,
  method: ReadBackHttpMethod,
  timeoutMs: number,
  maxBodyBytes: number,
  allowPrivateNetwork: boolean,
): Promise<ReadBackHttpResult> {
  try {
    await validateNetworkTarget(target, allowPrivateNetwork);
    const deadlineAt = Date.now() + timeoutMs;
    const response = await ky(target, {
      method,
      redirect: "manual",
      retry: 0,
      timeout: timeoutMs,
      throwHttpErrors: false,
      headers: { accept: "*/*" },
    });
    if (method === "HEAD") {
      return { statusCode: response.status, body: "", bodyDigest: undefined, complete: true };
    }
    const body = await readBody(response, maxBodyBytes, deadlineAt);
    return { statusCode: response.status, ...body };
  } catch (error) {
    if (error instanceof DisallowedNetworkTargetError) throw error;
    if (error instanceof Error) return failedReadBackHttpResult();
    throw error;
  }
}

export function digestObservedBody(result: ReadBackHttpResult): string | undefined {
  if (result.statusCode === undefined || !result.complete) return undefined;
  return result.bodyDigest;
}

export function isCompleteSuccess(result: ReadBackHttpResult): boolean {
  return (
    result.complete &&
    result.statusCode !== undefined &&
    result.statusCode >= 200 &&
    result.statusCode <= 299
  );
}

async function readBody(
  response: Response,
  maxBodyBytes: number,
  deadlineAt: number,
): Promise<Pick<ReadBackHttpResult, "body" | "bodyDigest" | "complete">> {
  const reader = response.body?.getReader();
  if (!reader) return { body: "", bodyDigest: digestBytes(new Uint8Array()), complete: true };

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        await reader.cancel();
        return incompleteBody();
      }
      const result = await readWithDeadline(() => reader.read(), remainingMs);
      if (result === "timeout") {
        await reader.cancel();
        return incompleteBody();
      }
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        return incompleteBody();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof Error) return incompleteBody();
    throw error;
  }
  const bodyBytes = collectBytes(chunks, bytes);
  return { body: decode(bodyBytes), bodyDigest: digestBytes(bodyBytes), complete: true };
}

async function readWithDeadline<T>(
  read: () => Promise<T>,
  remainingMs: number,
): Promise<T | "timeout"> {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function collectBytes(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function digestBytes(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function failedReadBackHttpResult(): ReadBackHttpResult {
  return { statusCode: undefined, body: "", bodyDigest: undefined, complete: false };
}

function incompleteBody(): Pick<ReadBackHttpResult, "body" | "bodyDigest" | "complete"> {
  return { body: "", bodyDigest: undefined, complete: false };
}

async function validateNetworkTarget(target: string, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  const hostname = new URL(target).hostname;
  const directAddress = parseAddress(hostname);
  const addresses =
    directAddress === undefined
      ? (await lookup(hostname, { all: true, verbatim: true })).map((address) => address.address)
      : [directAddress];

  const blocked = addresses.find(isBlockedAddress);
  if (blocked !== undefined) {
    throw new DisallowedNetworkTargetError(blocked);
  }
}

function parseAddress(hostname: string): string | undefined {
  if (isIP(hostname) !== 0) return hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1);
    if (isIP(address) !== 0) return address;
  }
  return undefined;
}

function isBlockedAddress(address: string): boolean {
  if (isIPv4Address(address)) return isBlockedIPv4(address);
  return isBlockedIPv6(address);
}

function isIPv4Address(address: string): boolean {
  return isIP(address) === 4;
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  if (first === undefined || second === undefined) return true;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedAddress = normalized.slice("::ffff:".length);
    return isIPv4Address(mappedAddress) ? isBlockedIPv4(mappedAddress) : true;
  }
  const firstSegment = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  if (Number.isNaN(firstSegment)) return true;
  return (
    (firstSegment & 0xfe00) === 0xfc00 ||
    (firstSegment & 0xffc0) === 0xfe80 ||
    (firstSegment & 0xff00) === 0xff00
  );
}
