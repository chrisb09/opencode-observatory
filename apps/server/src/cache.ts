// Cache keys always include tenant and generation. A write invalidates both values and in-flight reuse.
const generations = new Map<string, number>();
const entries = new Map<string, { expires: number; value: Promise<unknown> }>();
export function invalidateAnalytics(userId: string) {
  generations.set(userId, (generations.get(userId) ?? 0) + 1);
  for (const key of entries.keys()) if (key.startsWith(`${userId}:`)) entries.delete(key);
}
export async function cached<T>(userId: string, key: string, run: () => Promise<T>): Promise<T> {
  const full = `${userId}:${generations.get(userId) ?? 0}:${key}`;
  const hit = entries.get(full);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  if (entries.size >= 128) entries.delete(entries.keys().next().value!);
  const entry = { expires: Date.now() + 10000, value: run() };
  entries.set(full, entry);
  try { return await entry.value; }
  catch (error) { if (entries.get(full) === entry) entries.delete(full); throw error; }
}
