import { useEffect, useState } from "react";
import { Text } from "../../src";

/**
 * A live token row: swatch, name, resolved value, measured contrast.
 *
 * This is the one place in the repository allowed to reference a design token
 * by its custom-property name: a color chart whose colors were re-typed by hand
 * would drift from the tokens the moment either changed, which defeats the only
 * reason the chart exists. It reads the variables, it never redefines them.
 *
 * The contrast column is the point. "The light ramp looks quiet" and "the light
 * ramp is legible" are different claims, and only the second is checkable — so
 * the number the browser actually produces is printed beside the tone, in both
 * themes, next to the floor it has to clear. The same floors are asserted
 * numerically in test/tokens.test.ts; this page is where they are visible.
 */
export function Swatch({
  token,
  against,
  floor,
}: {
  readonly token: string;
  /** Surface token to measure `token` against, when `token` is a text tone. */
  readonly against?: string;
  /**
   * WCAG floor this pairing must clear. Omit for a SURFACE pairing, where the
   * ratio is an elevation delta rather than a legibility claim — a surface has
   * no floor to clear, it has a ceiling not to cross.
   */
  readonly floor?: number;
}) {
  const resolved = useResolvedToken(token);
  const surface = useResolvedToken(against ?? "");
  const measured = against ? contrast(resolved, surface) : null;

  return (
    <div className="flex min-h-row items-center gap-gutter">
      <span
        aria-hidden
        className="size-5 shrink-0 rounded-sm"
        style={{ backgroundColor: `var(${token})` }}
      />
      <Text className="w-44 shrink-0 truncate" level="micro" mono tone="subtle">
        {token}
      </Text>
      {/* Which surface the ratio was measured against. Without it, one tone
          printed three times reads as three tones. */}
      <Text className="w-24 shrink-0 truncate" level="micro" mono tone="faint">
        {against ? `on ${against.replace("--color-", "")}` : ""}
      </Text>
      {/* The value column flexes and the ratio is pinned right, so the sheet
          never grows a horizontal scrollbar — a reference page the reader has
          to pan sideways is a reference page with a hidden column. */}
      <Text
        className="min-w-0 flex-1 truncate"
        level="micro"
        mono
        tone={resolved === "" ? "accent" : "faint"}
      >
        {/* An empty value means the browser never emitted this token: it is
            declared but nothing references it. Saying so is the point — a blank
            cell would read as a rendering glitch instead of a dead token. */}
        {resolved === "" ? "not emitted — unclaimed step" : resolved}
      </Text>
      {measured !== null && (
        <Text
          className="w-28 shrink-0 text-right"
          level="micro"
          mono
          numeric
          tone={floor === undefined || measured >= floor ? "faint" : "accent"}
        >
          {measured.toFixed(2)}:1{floor === undefined ? "" : ` ≥ ${floor}`}
        </Text>
      )}
    </div>
  );
}

/**
 * The value the browser actually computed, re-read whenever the theme attribute
 * changes. A static label would claim the dark value while showing the light
 * one — the exact class of error a token chart is supposed to catch.
 */
function useResolvedToken(token: string): string {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (token === "") return;

    const read = () =>
      setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());

    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [token]);

  return value;
}

/**
 * WCAG contrast between two resolved `oklch(L% C H)` strings.
 *
 * Computed in the page rather than read from the test fixture, because the
 * claim this column makes is about what the BROWSER resolved: if a token moves
 * and the CSS still parses, this number moves with it.
 */
function contrast(first: string, second: string): number | null {
  const a = luminance(first);
  const b = luminance(second);
  if (a === null || b === null) return null;

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function luminance(oklch: string): number | null {
  const hit = oklch.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
  if (!hit) return null;

  const lightness = Number(hit[1]) / 100;
  const chroma = Number(hit[2]);
  const hue = (Number(hit[3]) * Math.PI) / 180;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const clamp = (channel: number) => Math.min(1, Math.max(0, channel));
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
