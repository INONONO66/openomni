export function measureEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      resolve(Date.now() - start);
    });
  });
}
