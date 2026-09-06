/**
 * WCAG contrast for the token file, computed from the oklch values the CSS
 * actually declares.
 *
 * This exists because "the light ramp looks quiet" and "the light ramp is
 * legible" are different claims, and only the second one is checkable. A tone
 * is placed against the surfaces it really appears on, and the ratio is a
 * number a test can fail on — the previous light theme shipped a `faint` tone
 * at 1.15:1 and passed every gate the repository had.
 *
 * Test-only: nothing in src imports this. The runtime never needs to know a
 * contrast ratio, because the ratios are decided here and baked into tokens.
 */

/** Linear-light sRGB from oklch. Björn Ottosson's matrices, no clamping yet. */
function oklchToLinearSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): readonly [number, number, number] {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Relative luminance per WCAG 2.x, from linear-light sRGB clamped to gamut. */
function relativeLuminance(lightness: number, chroma: number, hueDegrees: number): number {
  const [r, g, b] = oklchToLinearSrgb(lightness, chroma, hueDegrees).map((channel) =>
    Math.min(1, Math.max(0, channel)),
  ) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface Oklch {
  readonly lightness: number;
  readonly chroma: number;
  readonly hue: number;
}

/**
 * WCAG 2.x contrast ratio between two oklch colors, 1..21.
 *
 * Not exported: `ratio` below is the form every caller wants, and a second
 * public entry point differing only in rounding is how two call sites end up
 * reporting the same pair as 4.4952 and 4.5.
 */
function contrastRatio(a: Oklch, b: Oklch): number {
  const first = relativeLuminance(a.lightness, a.chroma, a.hue);
  const second = relativeLuminance(b.lightness, b.chroma, b.hue);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounded to two decimals, the form the report table prints. */
export function ratio(a: Oklch, b: Oklch): number {
  return Math.round(contrastRatio(a, b) * 100) / 100;
}
