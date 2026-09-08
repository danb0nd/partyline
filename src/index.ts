import { Hono } from "hono";
import { cors } from "hono/cors";
import { canDeleteRoom, canInvite } from "./access";
import { sha256Hex, signValue, verifySignedValue } from "./crypto";
import { sendMagicLink } from "./email";
import { hashPassword, validatePassword, verifyPassword } from "./password";
import { id, inviteCode, newBotToken } from "./ids";
import { ALLOWED_TYPES, MAX_BYTES, mediaKey, parseMediaKey, sniffType } from "./media";
import { ensureSchema } from "./schema";
import type { Actor, Attachment, Env, RoomRow } from "./types";

export { RoomDurableObject } from "./room";

type App = {
  Bindings: Env;
  Variables: { actor: Actor };
};

const COOKIE = "partyline_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_MS = 30 * 60 * 1000;

const app = new Hono<App>();

app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/")) {
    await ensureSchema(c.env);
  }
  await next();
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    name: c.env.APP_NAME || "Partyline",
    time: Date.now(),
    auth: "password",
    dev_auth: isDevAuth(c.env),
  }),
);

app.get("/api/auth/config", (c) =>
  c.json({
    mode: "password",
    dev_auth: isDevAuth(c.env),
    email_configured: Boolean(c.env.RESEND_API_KEY),
  }),
);

app.post("/api/auth/signup", async (c) => {
  const body = await readJson<{ email?: string; name?: string; password?: string }>(c);
  const email = normalizeEmail(body.email);
  const name = cleanName(body.name || (email ? email.split("@")[0] : ""));
  const password = typeof body.password === "string" ? body.password : "";
  if (!email) return c.json({ error: "valid email required" }, 400);
  if (!name) return c.json({ error: "name required" }, 400);
  const pwErr = validatePassword(password);
  if (pwErr) return c.json({ error: pwErr }, 400);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) return c.json({ error: "an account with that email already exists" }, 409);
  const userId = id("usr");
  const password_hash = await hashPassword(password);
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(userId, email, name, password_hash, Date.now())
    .run();
  c.header("Set-Cookie", await createSession(c.env, userId, isSecure(c.req.url)));
  return c.json(
    { user: { id: userId, email, name, kind: "human", role: "member" } },
    201,
  );
});

app.post("/api/auth/login", async (c) => {
  const body = await readJson<{ email?: string; password?: string }>(c);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return c.json({ error: "email and password required" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT id, email, name, password_hash FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{ id: string; email: string; name: string; password_hash: string | null }>();
  if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
    return c.json({ error: "invalid email or password" }, 401);
  }
  c.header("Set-Cookie", await createSession(c.env, row.id, isSecure(c.req.url)));
  return c.json({
    user: { id: row.id, email: row.email, name: row.name, kind: "human", role: "member" },
  });
});

app.post("/api/auth/magic-link", async (c) => {
  const body = await readJson<{ email?: string; name?: string }>(c);
  const email = normalizeEmail(body.email);
  const name = cleanName(body.name || email.split("@")[0]);
  if (!email) return c.json({ error: "valid email required" }, 400);
  const token = id("lnk", 16);
  const token_hash = await sha256Hex(token);
  await c.env.DB.prepare(
    "INSERT INTO magic_links (token_hash, email, name, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(token_hash, email, name, Date.now() + MAGIC_MS)
    .run();
  const origin = publicOrigin(c);
  const link = `${origin}/auth/callback?token=${token}`;
  let emailed = false;
  try {
    emailed = (await sendMagicLink(c.env, email, link)).emailed;
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "email failed" }, 502);
  }
  const reveal = !emailed || isDevAuth(c.env);
  return c.json({
    ok: true,
    emailed,
    ...(reveal ? { dev_link: link } : {}),
    message: emailed
      ? "Check your email for a sign-in link."
      : "Email is not configured. Use dev_link to sign in (set RESEND_API_KEY to send mail).",
  });
});

app.post("/api/auth/dev", async (c) => {
  if (!isDevAuth(c.env)) return c.json({ error: "DEV_AUTH is not enabled" }, 403);
  const body = await readJson<{ email?: string; name?: string }>(c);
  const email = normalizeEmail(body.email);
  const name = cleanName(body.name || (email ? email.split("@")[0] : "Human"));
  if (!email) return c.json({ error: "valid email required" }, 400);
  const user = await upsertUser(c.env, email, name);
  const cookie = await createSession(c.env, user.id, isSecure(c.req.url));
  c.header("Set-Cookie", cookie);
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, kind: "human", role: "member" },
  });
});

app.get("/auth/callback", async (c) => {
  const token = c.req.query("token") || "";
  if (!token) return c.text("Missing token", 400);
  const token_hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT email, name, expires_at FROM magic_links WHERE token_hash = ?",
  )
    .bind(token_hash)
    .first<{ email: string; name: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) {
    return c.text("This sign-in link is invalid or expired.", 400);
  }
  await c.env.DB.prepare("DELETE FROM magic_links WHERE token_hash = ?").bind(token_hash).run();
  const user = await upsertUser(c.env, row.email, row.name);
  c.header("Set-Cookie", await createSession(c.env, user.id, isSecure(c.req.url)));
  return c.redirect("/", 302);
});

app.post("/api/auth/logout", async (c) => {
  const sid = await sessionIdFromRequest(c);
  if (sid) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  c.header("Set-Cookie", clearCookie());
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const actor = await resolveActor(c);
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  return c.json({ actor, dev_auth: isDevAuth(c.env) });
});

app.post("/api/bots", async (c) => {
  const actor = await requireHuman(c);
  const body = await readJson<{ name?: string; role?: string }>(c);
  const name = cleanName(body.name || "");
  if (!name) return c.json({ error: "bot name required" }, 400);
  const role = cleanName(body.role || "agent") || "agent";
  const botId = id("bot");
  const token = newBotToken();
  const token_hash = await sha256Hex(token);
  await c.env.DB.prepare(
    "INSERT INTO bots (id, name, role, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(botId, name, role, token_hash, actor.id, Date.now())
    .run();
  return c.json(
    {
      bot: { id: botId, name, role, kind: "bot" },
      token,
      warning: "Store this token now. Partyline will not show it again.",
    },
    201,
  );
});

app.get("/api/bots", async (c) => {
  const actor = await requireHuman(c);
  const rows = await c.env.DB.prepare(
    "SELECT id, name, role, created_at FROM bots WHERE created_by = ? ORDER BY created_at DESC",
  )
    .bind(actor.id)
    .all<{ id: string; name: string; role: string; created_at: number }>();
  return c.json({ bots: rows.results || [] });
});

app.delete("/api/bots/:id", async (c) => {
  const actor = await requireHuman(c);
  const botId = c.req.param("id");
  const bot = await c.env.DB.prepare("SELECT id, created_by FROM bots WHERE id = ?")
    .bind(botId)
    .first<{ id: string; created_by: string }>();
  if (!bot || bot.created_by !== actor.id) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM bots WHERE id = ?").bind(botId).run();
  return c.json({ deleted: true, bot_id: botId });
});

app.get("/api/rooms", async (c) => {
  const actor = await requireActor(c);
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.name, r.invite_code, r.created_by, r.created_at
     FROM rooms r
     JOIN room_members m ON m.room_id = r.id
     WHERE m.actor_id = ?
     ORDER BY r.created_at DESC`,
  )
    .bind(actor.id)
    .all<RoomRow>();
  return c.json({ rooms: rows.results || [] });
});

app.post("/api/rooms", async (c) => {
  const actor = await requireActor(c);
  const body = await readJson<{ name?: string }>(c);
  const name = cleanName(body.name || "");
  if (!name) return c.json({ error: "room name required" }, 400);
  if (name.length > 80) return c.json({ error: "room name too long" }, 400);
  const roomId = id("rm");
  const code = inviteCode();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(roomId, name, code, actor.id, now)
    .run();
  await c.env.DB.prepare(
    "INSERT INTO room_members (room_id, actor_id, kind, name, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(roomId, actor.id, actor.kind, actor.name, "owner", now)
    .run();
  const res = await roomFetch(c.env, roomId, "/init", {
    method: "POST",
    headers: actorHeaders(actor),
    body: JSON.stringify({
      id: roomId,
      name,
      invite_code: code,
      created_by: actor.id,
      creator: actor,
    }),
  });
  if (!res.ok) {
    await c.env.DB.prepare("DELETE FROM room_members WHERE room_id = ?").bind(roomId).run();
    await c.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId).run();
    return c.json({ error: "failed to initialize room" }, 500);
  }
  return c.json(
    {
      room: {
        id: roomId,
        name,
        invite_code: code,
        created_by: actor.id,
        created_at: now,
      },
    },
    201,
  );
});

app.get("/api/rooms/:id", async (c) => {
  const actor = await requireActor(c);
  const room = await loadRoom(c.env, c.req.param("id"));
  if (!room) return c.json({ error: "room not found" }, 404);
  if (!(await isMember(c.env, room.id, actor.id))) {
    return c.json({ error: "not a member" }, 403);
  }
  const res = await roomFetch(c.env, room.id, "/state", { headers: actorHeaders(actor) });
  return passthrough(c, res);
});

app.delete("/api/rooms/:id", async (c) => {
  const actor = await requireActor(c);
  const room = await loadRoom(c.env, c.req.param("id"));
  if (!room) return c.json({ error: "room not found" }, 404);
  const member = await isMember(c.env, room.id, actor.id);
  if (!canDeleteRoom(actor, room, member)) {
    return c.json({ error: "only the creator or a human member can delete this room" }, 403);
  }
  const destroy = await roomFetch(c.env, room.id, "/", {
    method: "DELETE",
    headers: actorHeaders(actor),
  });
  let attachmentKeys: string[] = [];
  if (destroy.ok) {
    const body = (await destroy.json()) as { attachment_keys?: string[] };
    attachmentKeys = body.attachment_keys || [];
  }
  const r2_objects = await deleteRoomMedia(c.env, room.id, attachmentKeys);
  const mem = await c.env.DB.prepare("DELETE FROM room_members WHERE room_id = ?")
    .bind(room.id)
    .run();
  await c.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(room.id).run();
  return c.json({
    deleted: true,
    room_id: room.id,
    cleaned: {
      d1_room: true,
      d1_membership: mem.meta.changes ?? 0,
      durable_object: destroy.ok,
      r2_objects,
    },
    note: "Deleted the D1 room row, membership, Durable Object timeline, and R2 objects under room/{id}/. Bot identities and their tokens are kept.",
  });
});

app.post("/api/rooms/:id/join", async (c) => {
  const actor = await requireActor(c);
  const room = await loadRoom(c.env, c.req.param("id"));
  if (!room) return c.json({ error: "room not found" }, 404);
  const body = await readJson<{ invite_code?: string }>(c);
  if (await isMember(c.env, room.id, actor.id)) {
    return c.json({ room, joined: false });
  }
  if (!body.invite_code || body.invite_code !== room.invite_code) {
    return c.json({ error: "invalid invite code" }, 403);
  }
  await addMembership(c.env, room.id, actor);
  const res = await roomFetch(c.env, room.id, "/members", {
    method: "POST",
    headers: actorHeaders(actor),
    body: JSON.stringify({ ...actor, invite_code: body.invite_code }),
  });
  if (!res.ok) return passthrough(c, res);
  return c.json({ room, joined: true });
});

app.post("/api/rooms/:id/members", async (c) => {
  const actor = await requireActor(c);
  const room = await loadRoom(c.env, c.req.param("id"));
  if (!room) return c.json({ error: "room not found" }, 404);
  if (!(await isMember(c.env, room.id, actor.id))) {
    return c.json({ error: "not a member" }, 403);
  }
  if (!canInvite(actor, true)) {
    return c.json({ error: "cannot invite to this room" }, 403);
  }
  const body = await readJson<{ bot_id?: string; email?: string }>(c);
  if (body.bot_id) {
    const bot = await c.env.DB.prepare("SELECT id, name, role FROM bots WHERE id = ?")
      .bind(body.bot_id)
      .first<{ id: string; name: string; role: string }>();
    if (!bot) return c.json({ error: "bot not found" }, 404);
    const guest: Actor = { id: bot.id, kind: "bot", name: bot.name, role: bot.role };
    await addMembership(c.env, room.id, guest);
    const res = await roomFetch(c.env, room.id, "/members", {
      method: "POST",
      headers: actorHeaders(actor),
      body: JSON.stringify(guest),
    });
    return passthrough(c, res);
  }
  return c.json({ error: "bot_id required (humans join via invite link)" }, 400);
});

app.get("/api/rooms/:id/messages", async (c) => {
  const actor = await requireActor(c);
  const roomId = c.req.param("id");
  if (!(await isMember(c.env, roomId, actor.id))) return c.json({ error: "not a member" }, 403);
  const qs = new URL(c.req.url).search;
  const res = await roomFetch(c.env, roomId, `/messages${qs}`, { headers: actorHeaders(actor) });
  return passthrough(c, res);
});

app.post("/api/rooms/:id/messages", async (c) => {
  const actor = await requireActor(c);
  const roomId = c.req.param("id");
  if (!(await isMember(c.env, roomId, actor.id))) return c.json({ error: "not a member" }, 403);
  const res = await roomFetch(c.env, roomId, "/messages", {
    method: "POST",
    headers: actorHeaders(actor),
    body: JSON.stringify(await readJson(c)),
  });
  return passthrough(c, res);
});

app.post("/api/rooms/:id/typing", async (c) => {
  const actor = await requireActor(c);
  const roomId = c.req.param("id");
  if (!(await isMember(c.env, roomId, actor.id))) return c.json({ error: "not a member" }, 403);
  const res = await roomFetch(c.env, roomId, "/typing", {
    method: "POST",
    headers: actorHeaders(actor),
  });
  return passthrough(c, res);
});

app.post("/api/rooms/:id/upload", async (c) => {
  const actor = await requireActor(c);
  const roomId = c.req.param("id");
  const room = await loadRoom(c.env, roomId);
  if (!room) return c.json({ error: "room not found" }, 404);
  if (!(await isMember(c.env, roomId, actor.id))) return c.json({ error: "not a member" }, 403);

  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400);
  if (file.size <= 0) return c.json({ error: "empty file" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: `file too large (max ${MAX_BYTES} bytes)` }, 413);

  const type = sniffType(file.type, file.name);
  if (!type) {
    return c.json(
      { error: "unsupported type", allowed: Object.keys(ALLOWED_TYPES) },
      415,
    );
  }
  const spec = ALLOWED_TYPES[type];
  const key = mediaKey(roomId, id("obj"), spec.ext);
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: type },
    customMetadata: { name: file.name, room: roomId, by: actor.id },
  });
  const attachment: Attachment = {
    key,
    name: file.name || `upload.${spec.ext}`,
    content_type: type,
    size: file.size,
    kind: spec.kind,
  };

  const post = c.req.query("post") === "1" || form.post === "1" || form.post === "true";
  if (!post) return c.json({ attachment }, 201);

  const caption = typeof form.text === "string" ? form.text : "";
  const res = await roomFetch(c.env, roomId, "/messages", {
    method: "POST",
    headers: actorHeaders(actor),
    body: JSON.stringify({ text: caption, attachments: [attachment] }),
  });
  return passthrough(c, res);
});

app.get("/api/media", async (c) => {
  const actor = await requireActor(c);
  const key = c.req.query("key") || "";
  const parsed = parseMediaKey(key);
  if (!parsed) return c.json({ error: "invalid key" }, 400);
  if (!(await isMember(c.env, parsed.roomId, actor.id))) {
    return c.json({ error: "not a member" }, 403);
  }
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const headers = new Headers();
  headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "private, max-age=3600");
  const name = obj.customMetadata?.name;
  if (name) headers.set("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
  return new Response(obj.body, { headers });
});

app.get("/api/rooms/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "expected websocket upgrade" }, 426);
  }
  const actor = await requireActor(c);
  const roomId = c.req.param("id");
  if (!(await isMember(c.env, roomId, actor.id))) return c.json({ error: "not a member" }, 403);
  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(roomId));
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Partyline-Actor", JSON.stringify(actor));
  return stub.fetch(new Request(c.req.raw, { headers }));
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return app.fetch(request, env, ctx);
    }
    if (!env.ASSETS) return new Response("assets binding missing", { status: 500 });
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404 && !url.pathname.includes(".")) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return asset;
  },
};

function isDevAuth(env: Env): boolean {
  return String(env.DEV_AUTH || "").toLowerCase() === "true";
}

function publicOrigin(c: { env: Env; req: { url: string } }): string {
  if (c.env.APP_URL) return c.env.APP_URL.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

function normalizeEmail(email?: string): string {
  const v = (email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 40);
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

function actorHeaders(actor: Actor): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Partyline-Actor": JSON.stringify(actor),
  };
}

function roomFetch(env: Env, roomId: string, path: string, init?: RequestInit): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  return stub.fetch(new Request(`https://room${path}`, init));
}

async function passthrough(
  _c: unknown,
  res: Response,
): Promise<Response> {
  return new Response(res.body, { status: res.status, headers: res.headers });
}

async function loadRoom(env: Env, roomId: string): Promise<RoomRow | null> {
  return env.DB.prepare(
    "SELECT id, name, invite_code, created_by, created_at FROM rooms WHERE id = ?",
  )
    .bind(roomId)
    .first<RoomRow>();
}

async function isMember(env: Env, roomId: string, actorId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT actor_id FROM room_members WHERE room_id = ? AND actor_id = ?",
  )
    .bind(roomId, actorId)
    .first();
  return !!row;
}

async function addMembership(env: Env, roomId: string, actor: Actor): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, actor_id, kind, name, role, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(roomId, actor.id, actor.kind, actor.name, actor.role || "member", Date.now())
    .run();
}

async function deleteRoomMedia(env: Env, roomId: string, extra: string[]): Promise<number> {
  const keys = new Set(extra);
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list({ prefix: `room/${roomId}/`, cursor });
    for (const obj of listed.objects) keys.add(obj.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const all = [...keys];
  for (let i = 0; i < all.length; i += 100) {
    await env.MEDIA.delete(all.slice(i, i + 100));
  }
  return all.length;
}

async function upsertUser(
  env: Env,
  email: string,
  name: string,
): Promise<{ id: string; email: string; name: string }> {
  const existing = await env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; name: string }>();
  if (existing) {
    if (name && name !== existing.name) {
      await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, existing.id).run();
      return { ...existing, name };
    }
    return existing;
  }
  const user = { id: id("usr"), email, name, created_at: Date.now() };
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.email, user.name, user.created_at)
    .run();
  return user;
}

function isSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

async function createSession(env: Env, userId: string, secure: boolean): Promise<string> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  const sid = id("ses", 16);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(sid, userId, now + SESSION_MS, now)
    .run();
  const signed = await signValue(sid, env.SESSION_SECRET);
  const flags = [
    `${COOKIE}=${signed}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function sessionIdFromRequest(c: {
  env: Env;
  req: { header: (n: string) => string | undefined };
}): Promise<string | null> {
  if (!c.env.SESSION_SECRET) return null;
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySignedValue(decodeURIComponent(match[1]), c.env.SESSION_SECRET);
}

async function resolveActor(c: {
  env: Env;
  req: { header: (n: string) => string | undefined };
}): Promise<Actor | null> {
  const auth = c.req.header("Authorization") || "";
  if (auth.startsWith("Bearer pl_")) {
    const token_hash = await sha256Hex(auth.slice(7).trim());
    const bot = await c.env.DB.prepare(
      "SELECT id, name, role FROM bots WHERE token_hash = ?",
    )
      .bind(token_hash)
      .first<{ id: string; name: string; role: string }>();
    if (!bot) return null;
    return { id: bot.id, kind: "bot", name: bot.name, role: bot.role };
  }
  if (auth.startsWith("Bearer ses_") || auth.startsWith("Bearer ")) {
    const raw = auth.slice(7).trim();
    if (c.env.SESSION_SECRET && raw.includes(".")) {
      const sid = await verifySignedValue(raw, c.env.SESSION_SECRET);
      if (sid) {
        const human = await humanFromSession(c.env, sid);
        if (human) return human;
      }
    }
  }
  const sid = await sessionIdFromRequest(c);
  if (!sid) return null;
  return humanFromSession(c.env, sid);
}

async function humanFromSession(env: Env, sid: string): Promise<Actor | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
  )
    .bind(sid)
    .first<{ id: string; email: string; name: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, kind: "human", name: row.name, email: row.email, role: "member" };
}

async function requireActor(c: {
  env: Env;
  req: { header: (n: string) => string | undefined };
}): Promise<Actor> {
  const actor = await resolveActor(c);
  if (!actor) {
    throw new AuthError();
  }
  return actor;
}

async function requireHuman(c: {
  env: Env;
  req: { header: (n: string) => string | undefined };
}): Promise<Actor> {
  const actor = await requireActor(c);
  if (actor.kind !== "human") {
    throw new ForbiddenError("human session required");
  }
  return actor;
}

class AuthError extends Error {
  status = 401;
  constructor() {
    super("unauthorized");
  }
}

class ForbiddenError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
  }
}

app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: "unauthorized" }, 401);
  if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
  return c.json({ error: err.message || "internal error" }, 500);
});
