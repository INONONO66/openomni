export async function bounded<T>(signal: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test signal deadline")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
