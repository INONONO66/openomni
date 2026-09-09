const PRESENTATION_PROPS = ["tone", "edge", "as", "className", "children"] as const;

export function omitPresentationProps<T extends object>(props: T): T {
  const rest = { ...props };
  for (const key of PRESENTATION_PROPS) Reflect.deleteProperty(rest, key);
  return rest;
}
