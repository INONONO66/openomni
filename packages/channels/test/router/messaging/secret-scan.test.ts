import { describe, expect, test } from "bun:test";
import { scanForSecrets } from "../../../src/router/messaging/secret-scan.js";

/**
 * #811 detector unit suite. The scanner is a pure bounded function: it names
 * the class and the line, and never carries the matched bytes back out. Both
 * halves matter — a detector that leaks the credential into its own return
 * value re-creates the exfiltration it was written to stop.
 */

const PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qN2Q0e0Zk3+8H7bQKlY6zwvB4L",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

/**
 * Two of the provider fixtures are assembled from segments rather than written
 * as literals. Their shapes are valid enough that GitHub's own push protection
 * rejects a commit carrying them verbatim, which would make this suite
 * unpushable. The scanner still receives the identical joined string, so the
 * assertion is unchanged — keep them assembled.
 */
const SLACK_BOT_TOKEN = ["xoxb", "1234567890", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join(
  "-",
);
const SLACK_USER_TOKEN = ["xoxp", "1234567890", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join(
  "-",
);
const DISCORD_BOT_TOKEN = [
  "MTIzNDU2Nzg5MDEyMzQ1Njc4",
  "GhIjKl",
  "AbCdEfGhIjKlMnOpQrStUvWxYz01234",
].join(".");

describe("scanForSecrets: credential classes", () => {
  test("Given a PEM private key block, When scanned, Then it reports pem_private_key at the header line", () => {
    const hits = scanForSecrets(`intro\n${PRIVATE_KEY}`);

    expect(hits[0]).toEqual({ class: "pem_private_key", line: 2 });
  });

  test.each([
    ["openai", "sk-proj-Ab3dEf9hIjKlMn0pQrStUvWxYz012345678901"],
    ["anthropic", "sk-ant-api03-Ab3dEf9hIjKlMn0pQrStUvWxYz01234567"],
    ["github pat", "ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789"],
    ["github oauth", "gho_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789"],
    ["github fine-grained", "github_pat_11ABCDEFG0aB3dEf9hIjKlMnOpQrStUvWxYz"],
    ["slack bot", SLACK_BOT_TOKEN],
    ["slack user", SLACK_USER_TOKEN],
    ["aws access key", "AKIAIOSFODNN7EXAMPLE"],
    ["google api key", "AIzaSyD-1234567890abcdefghijklmnopqrstuvw"],
    ["telegram bot token", "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2"],
    ["discord bot token", DISCORD_BOT_TOKEN],
  ])("Given a %s token in prose, When scanned, Then provider_token is reported", (_name, token) => {
    const hits = scanForSecrets(`here is the value ${token} for you`);

    expect(hits.map((hit) => hit.class)).toContain("provider_token");
  });

  test.each([
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Ng==",
    "x-api-key: 8f4c1d2e9b7a63f50c1e8d4a2b9f7c30",
  ])("Given the auth header %p, When scanned, Then auth_header is reported", (header) => {
    const hits = scanForSecrets(`GET /v1/models\n${header}`);

    expect(hits.map((hit) => hit.class)).toContain("auth_header");
  });

  test.each([
    'password = "hunter2hunter2"',
    "api_key: sekritvalue123",
    "SECRET=zXcVbNmAsDfGhJk",
    "token := abcd1234efgh",
  ])("Given the credential assignment %p, When scanned, Then credential_assignment is reported", (line) => {
    const hits = scanForSecrets(`config:\n${line}`);

    expect(hits.map((hit) => hit.class)).toContain("credential_assignment");
  });

  test("Given a long opaque mixed-class token, When scanned, Then high_entropy_token is reported", () => {
    const hits = scanForSecrets("payload gT7kQ2vLp9wZx4mNb8rHc3yEuJ1sVd6oXt5 end");

    expect(hits.map((hit) => hit.class)).toContain("high_entropy_token");
  });

  test.each([
    ["userinfo", "https://agent:gT7kQ2vLp9wZx4mNb8rHc3yEuJ1sVd6oXt5@example.com/status"],
    ["path", "https://example.com/artifacts/gT7kQ2vLp9wZx4mNb8rHc3yEuJ1sVd6oXt5/result"],
    ["query", "https://example.com/callback?state=gT7kQ2vLp9wZx4mNb8rHc3yEuJ1sVd6oXt5"],
    ["fragment", "https://example.com/callback#gT7kQ2vLp9wZx4mNb8rHc3yEuJ1sVd6oXt5"],
  ])("Given a plaintext opaque secret in URI %s, When scanned, Then high_entropy_token is reported", (_component, uri) => {
    const hits = scanForSecrets(uri);

    expect(hits).toEqual([{ class: "high_entropy_token", line: 1 }]);
  });

  test("Given a long structured URL, When scanned, Then the entropy rule does not judge it", () => {
    const hits = scanForSecrets(
      "https://github.com/openomni/openomni/compare/main...feature/egress-gate?expand=1",
    );

    expect(hits).toEqual([]);
  });

  test("Given a secret inside a fenced code block, When scanned, Then it is still reported", () => {
    const hits = scanForSecrets(
      "```sh\nexport TOKEN=ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789\n```",
    );

    expect(hits.length).toBeGreaterThan(0);
  });

  test("Given a secret inside inline code, When scanned, Then it is still reported", () => {
    const hits = scanForSecrets("run `AKIAIOSFODNN7EXAMPLE` now");

    expect(hits.map((hit) => hit.class)).toContain("provider_token");
  });
});

describe("scanForSecrets: shape of the finding", () => {
  test("Given a matching line, When scanned, Then only class and line are returned — never the bytes", () => {
    const secret = "ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789";

    const hits = scanForSecrets(`prefix\n${secret}\n`);
    const serialized = JSON.stringify(hits);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("ghp_");
    for (const hit of hits) {
      expect([...Object.keys(hit)].sort()).toEqual(["class", "line"]);
    }
  });

  test("Given one line matching several rules, When scanned, Then that line yields exactly one hit", () => {
    const hits = scanForSecrets("Authorization: Bearer ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789");

    expect(hits).toHaveLength(1);
  });

  test("Given secrets on distinct lines, When scanned, Then each line is reported with its 1-based number", () => {
    const hits = scanForSecrets(
      [
        "clean",
        "AKIAIOSFODNN7EXAMPLE",
        "clean",
        "x-api-key: 8f4c1d2e9b7a63f50c1e8d4a2b9f7c30",
      ].join("\n"),
    );

    expect(hits.map((hit) => hit.line)).toEqual([2, 4]);
  });
});

/**
 * The benign corpus is the regression surface for false positives: every
 * entry is content the Resident legitimately sends. A rule change that makes
 * any of these hit is a UX regression, because #811 blocks with no allowlist
 * escape — the sender can only rephrase.
 */
const BENIGN_CORPUS: string[] = [
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "commit 8f4c1d2e9b7a63f50c1e8d4a2b9f7c30ab12cd34",
  "fixed in 8f4c1d2 and reverted in ab12cd34ef",
  "https://api.example.com/v1/items?page=2&sort=created_at&limit=100",
  "See https://github.com/openomni/openomni/pull/811#issuecomment-1234567890",
  "dGhpcyBpcyBzaG9ydA==",
  "| id | name | status |\n| --- | --- | --- |\n| 7 | build | green |",
  "[the design doc](./docs/gateway-design.md) explains the perimeter",
  "The router evaluates the egress gate once, before any durable side effect.",
  "게이트웨이는 발신 본문을 한 곳에서만 검사합니다. 통과하지 못하면 차단합니다.",
  "ゲートウェイは送信本文を一箇所だけで検査します。",
  "2026-09-02T11:04:35.221Z",
  '{"status":"ok","count":3,"nextPage":null}',
  "npm install @openomni/channels@1.4.2 --save-exact",
  "```ts\nconst limit = 4096;\nexport const kind = 'notify';\n```",
  "Password rotation is scheduled for Friday; nothing is pasted here.",
  "token bucket refill rate is 5 per minute",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
];

describe("scanForSecrets: benign corpus", () => {
  test.each(
    BENIGN_CORPUS,
  )("Given benign content %p, When scanned, Then nothing is reported", (text: string) => {
    expect(scanForSecrets(text)).toEqual([]);
  });

  test("Given the whole benign corpus as one document, When scanned, Then nothing is reported", () => {
    expect(scanForSecrets(BENIGN_CORPUS.join("\n\n"))).toEqual([]);
  });
});
