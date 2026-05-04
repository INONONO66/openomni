declare module "bun:test" {
  type TestCallback = (...args: unknown[]) => unknown | Promise<unknown>;
  type TestFunction = (name: string, fn: TestCallback, timeout?: number) => void;
  interface ExpectResult {
    not: ExpectResult;
    toBe(...args: unknown[]): void;
    toEqual(...args: unknown[]): void;
    toMatchObject(...args: unknown[]): void;
  }

  export const describe: TestFunction;
  export const test: TestFunction;
  export const expect: (actual: unknown) => ExpectResult;
}
