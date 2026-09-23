import { expect, test } from "bun:test";
import { isOriginSurface, OriginMark } from "../src/index";
import { attributes } from "./markup";

const SURFACES = ["slack", "discord", "telegram", "github"] as const;

test("only the four brand surfaces are origin surfaces", () => {
  for (const surface of SURFACES) expect(isOriginSurface(surface)).toBe(true);
  expect(isOriginSurface("ws")).toBe(false);
  expect(isOriginSurface("")).toBe(false);
});

test("every surface renders one labelled 12px SVG mark with its brand fill", () => {
  const fills: Record<(typeof SURFACES)[number], string> = {
    slack: "#E01E5A",
    discord: "#5865F2",
    telegram: "#26A5E4",
    github: "currentColor",
  };
  for (const surface of SURFACES) {
    const [mark] = attributes(<OriginMark surface={surface} />, '[data-ui="OriginMark"]');
    expect(mark?.role).toBe("img");
    expect(mark?.["aria-label"]).toBe(surface);
    expect(mark?.["data-surface"]).toBe(surface);
    expect(mark?.class).toContain("size-3");
    const [path] = attributes(<OriginMark surface={surface} />, `path[fill="${fills[surface]}"]`);
    expect(path?.d?.length ?? 0).toBeGreaterThan(0);
  }
});
