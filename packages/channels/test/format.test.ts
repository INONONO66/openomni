import { describe, expect, it } from "bun:test";
import { ChunkLengthError, chunkMarkdown } from "../src/support/format/chunk";
import { renderDiscordMarkdown } from "../src/support/format/discord";
import { tablesToBullets } from "../src/support/format/table";
import { renderTelegramMarkdown } from "../src/support/format/telegram";

describe("tablesToBullets", () => {
  it("passes text without pipes through byte-for-byte", () => {
    const text = "plain paragraph\n- a bullet\n";
    expect(tablesToBullets(text)).toBe(text);
  });

  it("passes pipe text without a separator row through", () => {
    const text = "a | b\nc | d";
    expect(tablesToBullets(text)).toBe(text);
  });

  it("rewrites a GFM table into bold-heading bullet groups", () => {
    const text = "| Name | Role | City |\n| --- | :-: | ---: |\n| Ana | dev | Seoul |\n| Bo | ops | Busan |";
    expect(tablesToBullets(text)).toBe(
      "**Ana**\n- Role: dev\n- City: Seoul\n\n**Bo**\n- Role: ops\n- City: Busan",
    );
  });

  it("fills missing trailing cells with empty values", () => {
    const text = "| K | V |\n| - | - |\n| solo |";
    expect(tablesToBullets(text)).toBe("**solo**\n- V: ");
  });

  it("renders a single-column table as bold rows without bullets", () => {
    const text = "| Only |\n| --- |\n| one |\n| two |";
    expect(tablesToBullets(text)).toBe("**one**\n\n**two**");
  });

  it("renders a header-only table as bold header names", () => {
    const text = "| A | B |\n| - | - |";
    expect(tablesToBullets(text)).toBe("**A**\n**B**");
  });

  it("leaves tables inside code fences untouched", () => {
    const text = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```";
    expect(tablesToBullets(text)).toBe(text);
  });

  it("keeps surrounding prose and converts only the table lines", () => {
    const text = "before\n| H |\n| - |\n| v |\nafter";
    expect(tablesToBullets(text)).toBe("before\n**v**\nafter");
  });
});

describe("chunkMarkdown", () => {
  it("refuses budgets too small for fence bookkeeping", () => {
    expect(() => chunkMarkdown("text", 10)).toThrow(ChunkLengthError);
  });

  it("returns short text as a single chunk", () => {
    expect(chunkMarkdown("hello", 64)).toEqual(["hello"]);
  });

  it("splits at line boundaries and keeps every chunk within budget", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line number ${i}`).join("\n");
    const chunks = chunkMarkdown(text, 64);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
    expect(chunks.join("\n")).toBe(text);
  });

  it("closes an interrupted code fence and reopens it with its info string", () => {
    const code = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const text = `\`\`\`ts\n${code}\n\`\`\``;
    const chunks = chunkMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.startsWith("```")).toBe(true);
      expect(chunk.endsWith("```")).toBe(true);
    }
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
  });

  it("does not close a fence on a tilde line inside a backtick fence", () => {
    const filler = "x".repeat(40);
    const text = `\`\`\`\n~~~\n${filler}\n${filler}\n\`\`\`\ntail`;
    const chunks = chunkMarkdown(text, 64);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
    const reassembled = chunks.join("\n");
    expect(reassembled).toContain("~~~");
    expect(reassembled.endsWith("tail")).toBe(true);
  });

  it("hard-splits a single line longer than the budget", () => {
    const text = `short\n${"a".repeat(300)}`;
    const chunks = chunkMarkdown(text, 64);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
    expect(chunks.join("").replaceAll("\n", "")).toContain("a".repeat(64));
  });

  it("hard-splits an overlong line inside a fence and keeps fences balanced", () => {
    const text = `\`\`\`js\n${"b".repeat(200)}\n\`\`\``;
    const chunks = chunkMarkdown(text, 64);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(64);
      expect(chunk.startsWith("```")).toBe(true);
      expect(chunk.endsWith("```")).toBe(true);
    }
  });
});

describe("renderTelegramMarkdown", () => {
  it("converts headers to bold and strips redundant bold inside them", () => {
    expect(renderTelegramMarkdown("## Big **Deal** Title")).toBe("*Big Deal Title*");
  });

  it("converts bold, italic, and strikethrough to MarkdownV2 entities", () => {
    expect(renderTelegramMarkdown("**bold** and *ital* and ~~gone~~")).toBe(
      "*bold* and _ital_ and ~gone~",
    );
  });

  it("escapes every MarkdownV2 special in plain text", () => {
    expect(renderTelegramMarkdown("a.b!c-d(e)f")).toBe("a\\.b\\!c\\-d\\(e\\)f");
  });

  it("escapes specials inside styled bodies", () => {
    expect(renderTelegramMarkdown("**v1.2!**")).toBe("*v1\\.2\\!*");
  });

  it("converts links, escaping the label and the url per spec", () => {
    expect(renderTelegramMarkdown("[docs v1.0](https://x.dev/a(b))")).toBe(
      "[docs v1\\.0](https://x.dev/a(b\\))",
    );
  });

  it("keeps bold styling around a link via nested placeholder restore", () => {
    expect(renderTelegramMarkdown("**see [site](https://a.io)**")).toBe(
      "*see [site](https://a.io)*",
    );
  });

  it("protects inline code bodies and escapes backslashes inside them", () => {
    expect(renderTelegramMarkdown("run `a_b\\c.d` now")).toBe("run `a_b\\\\c.d` now");
  });

  it("protects fenced code and escapes backticks and backslashes in the body", () => {
    expect(renderTelegramMarkdown("```py\nx = '`\\\\'\n```")).toBe("```py\nx = '\\`\\\\\\\\'\n```");
  });

  it("protects a single-line fenced span from styling and escape passes", () => {
    expect(renderTelegramMarkdown("```raw**not bold**```")).toBe("```raw**not bold**```");
  });

  it("rewrites tables before conversion so groups render as bold", () => {
    expect(renderTelegramMarkdown("| H | V |\n| - | - |\n| k | 1 |")).toBe("*k*\n\\- V: 1");
  });

  it("strips the sentinel character so placeholder framing cannot be forged", () => {
    expect(renderTelegramMarkdown("a\uE0000\uE000b")).toBe("a0b");
  });
});

describe("renderDiscordMarkdown", () => {
  it("rewrites tables and passes every other construct through", () => {
    const text = "**bold** stays\n| H | V |\n| - | - |\n| k | 1 |";
    expect(renderDiscordMarkdown(text)).toBe("**bold** stays\n**k**\n- V: 1");
  });
});
