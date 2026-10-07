// Reads the prompt-cache clock off a Pi session branch: the last real request, any cache-warming
// refreshes after it, and whether a compaction has replaced the context since.
import type { ColdReason, Price } from "./core.ts";

export interface LastRequest {
  /** When the cache entry was last read or written: the last real request or warming refresh. */
  at: number;
  /** When the last real (non-warming) request started. */
  realAt: number;
  /** Prompt tokens the next request re-sends: the last prompt plus the reply it produced. */
  tokens: number;
  provider: string;
  model: string;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Walks the branch back from its tip. Warming entries (`usage`, kind `cache_warm`) that hit the
 * cache move `at` forward; a compaction or branch summary after the last request means the next
 * request carries new context, so there is no cache to keep or lose.
 */
export function lastRequest(entries: readonly unknown[]): LastRequest | undefined {
  let warmedAt = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as Record<string, any>;
    if (entry?.type === "compaction" || entry?.type === "branch_summary") return undefined;
    if (entry?.type === "usage" && entry.kind === "cache_warm") {
      const usage = entry.usage as UsageLike | undefined;
      // The entry is written when the one-token refresh returns; it started a moment earlier.
      const at = Date.parse(entry.timestamp) - 2_000;
      if ((usage?.cacheRead ?? 0) > 0 && Number.isFinite(at)) warmedAt = Math.max(warmedAt, at);
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const message = entry.message;
    const usage = message.usage as UsageLike | undefined;
    const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    if (prompt <= 0) continue; // errors and aborts before a response carry no usage
    const realAt = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
    return {
      at: Math.max(realAt, warmedAt),
      realAt,
      tokens: prompt + (usage?.output ?? 0),
      provider: String(message.provider ?? ""),
      model: String(message.model ?? ""),
    };
  }
  return undefined;
}

export interface CacheView {
  /** Present while the last request's entry is still alive. */
  remainingMs?: number;
  /** Why the next request misses, when it does. */
  cold?: ColdReason;
  last: LastRequest;
  ttlMs?: number;
  price?: Price;
}

export interface ModelInfo {
  provider: string;
  id: string;
  ttlMs?: number;
  price?: Price;
}

/**
 * Where the cache stands for a request on `current`: warm with time left, expired, gone with a
 * model switch, or (for a provider without a published TTL) probably gone after a long idle.
 */
export function view(last: LastRequest, current: ModelInfo, now: number, idleWarnMs: number): CacheView {
  if (current.provider !== last.provider || current.id !== last.model) {
    return { last, cold: { kind: "model", from: last.model, to: current.id }, ttlMs: current.ttlMs, price: current.price };
  }
  const idleMs = Math.max(0, now - last.at);
  if (current.ttlMs === undefined) {
    return { last, price: current.price, cold: idleMs >= idleWarnMs ? { kind: "idle", idleMs } : undefined };
  }
  const left = last.at + current.ttlMs - now;
  if (left > 0) return { last, remainingMs: left, ttlMs: current.ttlMs, price: current.price };
  return { last, ttlMs: current.ttlMs, price: current.price, cold: { kind: "expired", idleMs: -left } };
}
