declare module "bun:test" {
  type TestCallback = (...args: unknown[]) => unknown | Promise<unknown>;
  type TestFunction = (name: string, fn: TestCallback, timeout?: number) => void;
  type HookFunction = (fn: TestCallback, timeout?: number) => void;
  interface ExpectResult {
    not: ExpectResult;
    resolves: ExpectResult;
    rejects: ExpectResult;
    toBe(...args: unknown[]): void;
    toEqual(...args: unknown[]): void;
    toContain(...args: unknown[]): void;
    toHaveLength(...args: unknown[]): void;
    toHaveBeenCalled(...args: unknown[]): void;
    toHaveBeenCalledTimes(...args: unknown[]): void;
    toHaveBeenCalledWith(...args: unknown[]): void;
    toHaveProperty(...args: unknown[]): void;
    toMatch(...args: unknown[]): void;
    toMatchObject(...args: unknown[]): void;
    toBeDefined(...args: unknown[]): void;
    toBeUndefined(...args: unknown[]): void;
    toBeNull(...args: unknown[]): void;
    toBeInstanceOf(...args: unknown[]): void;
    toBeGreaterThan(...args: unknown[]): void;
    toBeGreaterThanOrEqual(...args: unknown[]): void;
    toBeLessThan(...args: unknown[]): void;
    toBeLessThanOrEqual(...args: unknown[]): void;
    toThrow(...args: unknown[]): void;
  }
  type MockFunction = ((...args: unknown[]) => never) & {
    mock: { calls: unknown[][] };
    mockClear(): void;
    mockImplementation<T>(fn: T): MockFunction & T;
    mockReset(): void;
    mockResolvedValue(value: unknown): MockFunction;
  };

  export const beforeAll: HookFunction;
  export const afterAll: HookFunction;
  export const beforeEach: HookFunction;
  export const afterEach: HookFunction;
  export const describe: TestFunction;
  export const expect: (actual: unknown) => ExpectResult;
  export const it: TestFunction;
  export const mock: {
    <T>(fn?: T): MockFunction & T;
    module(specifier: string, factory: () => unknown): void;
    restore(): void;
  };
  export const test: TestFunction;
}
