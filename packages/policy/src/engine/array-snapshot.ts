export type FrozenArrayCapture =
  | { readonly success: true; readonly value: unknown[] }
  | { readonly success: false };

export function captureFrozenArray(value: unknown): FrozenArrayCapture {
  try {
    if (!Array.isArray(value)) return { success: false };
    const snapshot: unknown[] = [];
    const length: unknown = Reflect.get(value, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      return { success: false };
    }
    for (let index = 0; index < length; index += 1) {
      snapshot.push(Reflect.get(value, index));
    }
    Object.freeze(snapshot);
    return { success: true, value: snapshot };
  } catch {
    return { success: false };
  }
}
