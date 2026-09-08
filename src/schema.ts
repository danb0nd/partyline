import type { Env } from "./types";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, actor_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (bucket, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_members_actor ON room_members(actor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at)`,
];

/**
 * Per-isolate latch. ensureSchema ran on every single API request before this,
 * costing a dozen round trips to D1 to re-assert a schema that had not changed
 * since deploy. An isolate handles many requests, so latching here removes
 * nearly all of that; a cold isolate still pays once, which is the point.
 */
let schemaReady: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = applySchema(env).catch((err) => {
      // Never cache a failure: the next request should retry rather than
      // inherit a permanently broken isolate.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Test seam — lets a suite start from a known-cold state. */
export function resetSchemaCache(): void {
  schemaReady = null;
}

async function applySchema(env: Env): Promise<void> {
  for (const sql of STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  await addColumnIfMissing(env, "users", "password_hash", "TEXT");
  await dropColumnIfPresent(env, "bots", "webhook_url");
  await dropColumnIfPresent(env, "bots", "webhook_secret");
}

/**
 * Delete rows that are only meaningful before their expiry. Sessions, magic
 * links and rate-limit windows all accumulate forever otherwise — magic_links
 * in particular gains a row per sign-in attempt and previously lost one only
 * when a link was actually used.
 *
 * Cheap enough to run from a request's waitUntil rather than needing a cron.
 */
export async function sweepExpired(env: Env, now = Date.now()): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
    ]);
  } catch {
    /* housekeeping is best-effort; never fail a request over it */
  }
}

async function addColumnIfMissing(
  env: Env,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (!(cols.results || []).some((c) => c.name === column)) {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}

async function dropColumnIfPresent(env: Env, table: string, column: string): Promise<void> {
  const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if ((cols.results || []).some((c) => c.name === column)) {
    await env.DB.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
  }
}
