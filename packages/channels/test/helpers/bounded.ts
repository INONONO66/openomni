export async function bounded<T>(signal: Promise<T>): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error("channel event deadline exceeded")), 10_000);
  try { return await Promise.race([signal, expired.promise]); }
  finally { clearTimeout(timer); }
}
