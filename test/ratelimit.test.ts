import { describe, expect, it } from "vitest";
import { clientKey, consume, type RateLimit } from "../src/ratelimit";
import type { Env } from "../src/types";

/**
 * Just enough D1 to exercise the limiter: the only two statements it issues
 * are the upsert and the read-back, so the stub recognises them by shape and
 * keeps counts in a Map.
 */
function fakeDb(opts: { failOn?: "upsert" | "read" } = {}) {
  const counts = new Map<string, number>();
  const db = {
    prepare(sql: string) {
      const isUpsert = sql.includes("INSERT INTO rate_limits");
      return {
        bind(...args: unknown[]) {
          const key = `${args[0]}|${args[1]}`;
          return {
            async run() {
              if (opts.failOn === "upsert") throw new Error("d1 down");
              counts.set(key, (counts.get(key) ?? 0) + 1);
              return { meta: { changes: 1 } };
            },
            async first<T>() {
              if (opts.failOn === "read") throw new Error("d1 down");
              if (isUpsert) return null;
              return { count: counts.get(key) ?? 0 } as T;
            },
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, counts };
}

const RULE: RateLimit = { limit: 3, windowMs: 60_000 };

describe("consume", () => {
  it("permits up to the limit then refuses", async () => {
    const { env } = fakeDb();
    const now = 1_000_000;
    const verdicts = [];
    for (let i = 0; i < 4; i++) verdicts.push(await consume(env, "login:a", RULE, now));
    expect(verdicts.map((v) => v.ok)).toEqual([true, true, true, false]);
  });

  it("reports the remaining budget", async () => {
    const { env } = fakeDb();
    const now = 1_000_000;
    expect((await consume(env, "login:a", RULE, now)).remaining).toBe(2);
    expect((await consume(env, "login:a", RULE, now)).remaining).toBe(1);
  });

  it("keeps separate buckets separate", async () => {
    const { env } = fakeDb();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) await consume(env, "login:a", RULE, now);
    expect((await consume(env, "login:a", RULE, now)).ok).toBe(false);
    expect((await consume(env, "login:b", RULE, now)).ok).toBe(true);
  });

  it("resets in the next window", async () => {
    const { env } = fakeDb();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) await consume(env, "login:a", RULE, now);
    expect((await consume(env, "login:a", RULE, now)).ok).toBe(false);
    expect((await consume(env, "login:a", RULE, now + RULE.windowMs)).ok).toBe(true);
  });

  it("counts down retryAfter within a window", async () => {
    const { env } = fakeDb();
    const start = 60_000; // aligned to the window boundary
    expect((await consume(env, "k", RULE, start)).retryAfter).toBe(60);
    expect((await consume(env, "k", RULE, start + 30_000)).retryAfter).toBe(30);
  });

  it("fails open when D1 errors, rather than locking everyone out", async () => {
    for (const failOn of ["upsert", "read"] as const) {
      const { env } = fakeDb({ failOn });
      const verdict = await consume(env, "login:a", RULE, 1_000_000);
      expect(verdict.ok).toBe(true);
      expect(verdict.remaining).toBe(RULE.limit);
    }
  });
});

describe("clientKey", () => {
  it("uses the Cloudflare-set address", () => {
    expect(clientKey({ header: (n) => (n === "CF-Connecting-IP" ? "203.0.113.7" : undefined) })).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to a shared bucket rather than to no limit", () => {
    expect(clientKey({ header: () => undefined })).toBe("unknown");
  });
});
