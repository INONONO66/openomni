/** Awaits a test signal, failing with the labelled deadline instead of hanging the run. */
export async function bounded<T>(
  signal: Promise<T>,
  label = "test signal",
  timeoutMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
