import type { Env } from "./types";

/**
 * Fixed-window rate limiting backed by D1.
 *
 * Deliberately not a Durable Object: these limits guard *unauthenticated*
 * endpoints, and routing every failed login through a DO would hand an
 * attacker a cheap way to spin up objects. One indexed D1 row per bucket is
 * enough for the traffic Partyline sees, and it survives isolate recycling.
 */
export interface RateLimit {
  /** Requests permitted inside one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateVerdict {
  ok: boolean;
  /** Seconds until the current window rolls over. Sent as Retry-After. */
  retryAfter: number;
  remaining: number;
}

/** Login is the expensive one: each attempt costs a 100k-iteration PBKDF2. */
export const LOGIN_LIMIT: RateLimit = { limit: 8, windowMs: 15 * 60_000 };
export const SIGNUP_LIMIT: RateLimit = { limit: 5, windowMs: 60 * 60_000 };
export const MAGIC_LINK_LIMIT: RateLimit = { limit: 5, windowMs: 60 * 60_000 };
/** Generous — this one only exists to stop a runaway agent loop. */
export const POST_LIMIT: RateLimit = { limit: 120, windowMs: 60_000 };

/**
 * Consume one unit against `key`. Returns the verdict; the caller decides
 * whether to 429. Never throws — a rate limiter that takes the site down when
 * its own table misbehaves is worse than one that briefly lets traffic past.
 */
export async function consume(
  env: Env,
  key: string,
  rule: RateLimit,
  now = Date.now(),
): Promise<RateVerdict> {
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const resetAt = windowStart + rule.windowMs;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  try {
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket, window_start)
       DO UPDATE SET count = count + 1`,
    )
      .bind(key, windowStart, resetAt)
      .run();
    const row = await env.DB.prepare(
      "SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?",
    )
      .bind(key, windowStart)
      .first<{ count: number }>();
    const count = row?.count ?? 1;
    return { ok: count <= rule.limit, retryAfter, remaining: Math.max(0, rule.limit - count) };
  } catch {
    return { ok: true, retryAfter, remaining: rule.limit };
  }
}

/**
 * Client address for bucketing. Cloudflare sets CF-Connecting-IP and strips
 * any client-supplied copy, so it cannot be spoofed the way X-Forwarded-For
 * can. Falls back to a constant so a missing header degrades to a shared
 * bucket rather than to no limit at all.
 */
export function clientKey(req: { header: (name: string) => string | undefined }): string {
  return req.header("CF-Connecting-IP") || "unknown";
}
