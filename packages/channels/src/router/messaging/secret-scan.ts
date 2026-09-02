/**
 * #811 outbound secret detector. A pure, bounded, line-oriented scanner: it
 * reports WHICH class of credential shape a line carries and WHERE, and it
 * deliberately returns neither the matched bytes, the column, nor any
 * surrounding context — a detector that echoes the credential into its own
 * result re-creates the exfiltration it exists to stop.
 *
 * Honest limits (docs/gateway-design.md S9): encoded, split, or encrypted
 * exfiltration is out of scope. The high-entropy rule has false positives;
 * #811 answers them with block-plus-feedback and no allowlist, so the sender
 * rephrases. Every rule is anchored to a single line, so cost is linear in
 * the body and the gate can run on every send attempt.
 */

type SecretClass =
  | "pem_private_key"
  | "provider_token"
  | "auth_header"
  | "credential_assignment"
  | "high_entropy_token";

export interface SecretHit {
  readonly class: SecretClass;
  readonly line: number;
}

/**
 * Rules are evaluated in declaration order and a line yields at most its
 * first hit — the most specific classes come first so the feedback names the
 * strongest reason a line was refused.
 */
const PATTERN_RULES: readonly (readonly [SecretClass, RegExp])[] = [
  ["pem_private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "provider_token",
    new RegExp(
      [
        // OpenAI / Anthropic style: sk- and sk-ant- with a long body.
        "sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
        // GitHub classic, OAuth, and fine-grained tokens.
        "gh[pousr]_[A-Za-z0-9]{20,}",
        "github_pat_[A-Za-z0-9_]{20,}",
        // Slack bot/user tokens.
        "xox[bp]-[A-Za-z0-9-]{20,}",
        // AWS access key id.
        "AKIA[0-9A-Z]{16}",
        // Google API key.
        "AIza[0-9A-Za-z_-]{35}",
        // Telegram bot token.
        "\\b\\d{8,10}:[A-Za-z0-9_-]{35}\\b",
        // Discord bot token.
        "[MN][A-Za-z\\d]{23,}\\.[\\w-]{6}\\.[\\w-]{27,}",
      ].join("|"),
    ),
  ],
  ["auth_header", /(?:authorization:\s*(?:bearer|basic)\s+\S{16,}|x-api-key:\s*\S{16,})/i],
  [
    "credential_assignment",
    /(?:password|passwd|secret|token|api[_-]?key)\s*(?::=|[:=])\s*["']?\S{8,}/i,
  ],
];

/** Bare-token delimiters preserve every character in the opaque alphabet. */
const OPAQUE_TOKEN_SPLIT = /[\s"'`,;()[\]{}<>]+/;
const URI_SHAPED_SPAN =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:\[[^\s"'`,;(){}<>]*\]|[^\s"'`,;()[\]{}<>])+/g;
const URI_PATH_OR_USERINFO_SPLIT = /[/:@]+/;
const URI_FIELD_SPLIT = /[?#&]+/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/**
 * The alphabet an opaque credential is drawn from (base64/base64url/hex plus
 * the separators real tokens use). A token carrying any other character is
 * structured text — a URL, a path, a sentence — and the entropy rule does not
 * judge structure.
 */
const OPAQUE_TOKEN = /^[A-Za-z0-9+/=_.~-]+$/;
const MIN_ENTROPY_TOKEN_LENGTH = 32;
const MIN_CHARACTER_CLASSES = 3;
const MIN_ENTROPY_BITS_PER_CHAR = 4.5;

function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function characterClassCount(token: string): number {
  return (
    (/[a-z]/.test(token) ? 1 : 0) +
    (/[A-Z]/.test(token) ? 1 : 0) +
    (/[0-9]/.test(token) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(token) ? 1 : 0)
  );
}

/**
 * Long, mixed-class, high-entropy tokens are credential-shaped. Hex-only
 * tokens are excluded structurally: git SHAs, `sha256:` digests, and UUIDs
 * are hex (or hex plus dashes) and would otherwise be permanent false
 * positives on ordinary engineering prose.
 */
function isHighEntropyOpaqueToken(token: string): boolean {
  if (token.length < MIN_ENTROPY_TOKEN_LENGTH) return false;
  if (!OPAQUE_TOKEN.test(token)) return false;
  const compact = token.replaceAll("-", "");
  if (HEX_ONLY.test(compact)) return false;
  if (characterClassCount(token) < MIN_CHARACTER_CLASSES) return false;
  return shannonEntropy(token) >= MIN_ENTROPY_BITS_PER_CHAR;
}

function hasHighEntropyToken(line: string): boolean {
  for (const uri of line.match(URI_SHAPED_SPAN) ?? []) {
    for (const component of uri.split(URI_PATH_OR_USERINFO_SPLIT)) {
      if (isHighEntropyOpaqueToken(component)) return true;
    }
    for (const field of uri.split(URI_FIELD_SPLIT)) {
      const value = field.slice(field.indexOf("=") + 1);
      if (isHighEntropyOpaqueToken(value)) return true;
    }
  }
  for (const token of line.split(OPAQUE_TOKEN_SPLIT)) {
    if (isHighEntropyOpaqueToken(token)) return true;
  }
  return false;
}

function classify(line: string): SecretClass | undefined {
  for (const [secretClass, pattern] of PATTERN_RULES) {
    if (pattern.test(line)) return secretClass;
  }
  return hasHighEntropyToken(line) ? "high_entropy_token" : undefined;
}

/**
 * Scans outbound text for credential shapes. Pure: same text in, same hits
 * out, no I/O, no state. Fenced and inline code are scanned like any other
 * line — a credential does not stop being one inside backticks.
 */
export function scanForSecrets(text: string): readonly SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const secretClass = classify(line);
    if (secretClass !== undefined) hits.push({ class: secretClass, line: index + 1 });
  }
  return hits;
}
