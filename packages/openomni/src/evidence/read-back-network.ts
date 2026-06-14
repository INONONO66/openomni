import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ValidatedReadBackTarget = {
  readonly url: URL;
  readonly address: string;
  readonly hostHeader: string;
  readonly serverName: string | undefined;
};

export class DisallowedNetworkTargetError extends Error {
  constructor(address: string) {
    super(`read-back target resolves to a private network address: ${address}`);
    this.name = "DisallowedNetworkTargetError";
  }
}

export async function validateNetworkTarget(
  target: string,
  allowPrivateNetwork: boolean,
): Promise<ValidatedReadBackTarget> {
  const url = new URL(target);
  const directAddress = parseAddress(url.hostname);
  const addresses =
    directAddress === undefined
      ? (await lookup(url.hostname, { all: true, verbatim: true })).map(
          (address) => address.address,
        )
      : [directAddress];

  if (!allowPrivateNetwork) {
    const blocked = addresses.find(isBlockedAddress);
    if (blocked !== undefined) {
      throw new DisallowedNetworkTargetError(blocked);
    }
  }

  const [address] = addresses;
  if (address === undefined) {
    throw new Error(`read-back target did not resolve: ${url.hostname}`);
  }

  return {
    url,
    address,
    hostHeader: url.host,
    serverName: isIP(url.hostname) === 0 ? url.hostname : undefined,
  };
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
