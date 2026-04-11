import { BUILTIN_CATEGORIES } from "./builtin-categories";
import type { CategoryConfig, CategoryResolution } from "./category";

const fallbackCategory =
  BUILTIN_CATEGORIES.find((category) => category.name === "unspecified-low") ??
  (() => {
    throw new Error("BUILTIN_CATEGORIES must include unspecified-low fallback");
  })();

function findCategory(name: string, categories?: CategoryConfig[]): CategoryConfig | undefined {
  return categories?.find((category) => category.name === name);
}

export function resolveCategory(name: string, custom?: CategoryConfig[]): CategoryResolution {
  const customCategory = findCategory(name, custom);
  if (customCategory) {
    return { config: customCategory, source: "custom" };
  }

  const builtinCategory = findCategory(name, BUILTIN_CATEGORIES);
  if (builtinCategory) {
    return { config: builtinCategory, source: "builtin" };
  }

  return { config: fallbackCategory, source: "fallback" };
}
