import { DurableObject } from "cloudflare:workers";
import { canDeleteRoom } from "./access";
import { id } from "./ids";
import { extractMentions, mentionsMember } from "./mentions";
import type { Actor, Attachment, Env, Member, Message } from "./types";

interface RoomMeta {
  id: string;
  name: string;
  invite_code: string;
  created_by: string;
  created_at: number;
}

export class RoomDurableObject extends DurableObject<Env> {
  private ready = false;

  private ensureTables(): void {
    if (this.ready) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_role TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    `);
    this.ready = true;
  }

  private meta(): RoomMeta | null {
    const rows = this.ctx.storage.sql.exec("SELECT key, value FROM meta").toArray() as {
      key: string;
      value: string;
    }[];
    if (!rows.length) return null;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!map.id || !map.name) return null;
    return {
      id: map.id,
      name: map.name,
      invite_code: map.invite_code || "",
      created_by: map.created_by || "",
      created_at: Number(map.created_at || 0),
    };
  }

  private members(): Member[] {
    return (
      this.ctx.storage.sql.exec(
        "SELECT id, kind, name, role, joined_at FROM members ORDER BY joined_at ASC",
      ).toArray() as unknown as Member[]
    ).map((m) => ({
      ...m,
      joined_at: Number(m.joined_at),
    }));
  }

  private onlineIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const tag = this.ctx.getTags(ws)[0];
      if (tag) ids.add(tag);
    }
    return ids;
  }

  private membersWithPresence(): Member[] {
    const online = this.onlineIds();
    return this.members().map((m) => ({ ...m, online: online.has(m.id) }));
  }

  private broadcast(payload: unknown, except?: WebSocket): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (except && ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* socket already closing */
      }
    }
  }

  /**
   * Like broadcast, but builds the payload per recipient from that socket's
   * own actor. Used where the message differs by who is reading it.
   */
  private broadcastPerSocket(build: (recipient: Actor) => unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { actor?: Actor } | null;
      if (!attachment?.actor) continue;
      try {
        ws.send(JSON.stringify(build(attachment.actor)));
      } catch {
        /* socket already closing */
      }
    }
  }

  private requireMember(actor: Actor): Member {
    const row = this.ctx.storage.sql
      .exec("SELECT id, kind, name, role, joined_at FROM members WHERE id = ?", actor.id)
      .toArray()[0] as unknown as Member | undefined;
    if (!row) throw new HttpError(403, "not a member of this room");
    return { ...row, joined_at: Number(row.joined_at) };
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureTables();
    try {
      if (request.headers.get("Upgrade") === "websocket") {
        return this.acceptSocket(request);
      }
      const url = new URL(request.url);
      const actor = readActor(request);
      switch (`${request.method} ${url.pathname}`) {
        case "POST /init":
          return this.init(await request.json());
        case "GET /state":
          return this.state(actor);
        case "GET /messages":
          return this.listMessages(actor, url);
        case "POST /messages":
          return this.postMessage(actor, await request.json());
        case "POST /members":
          return this.addMember(actor, await request.json());
        case "POST /typing":
          return this.typing(actor);
        case "DELETE /":
          return this.destroy(actor);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      return json({ error: err instanceof Error ? err.message : "room error" }, 500);
    }
  }

  private async init(body: {
    id: string;
    name: string;
    invite_code: string;
    created_by: string;
    creator: Actor;
  }): Promise<Response> {
    const existing = this.meta();
    if (existing) return json({ room: existing, members: this.membersWithPresence() });
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", "id", body.id);
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", "name", body.name);
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      "invite_code",
      body.invite_code,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      "created_by",
      body.created_by,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      "created_at",
      String(now),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO members (id, kind, name, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      body.creator.id,
      body.creator.kind,
      body.creator.name,
      "owner",
      now,
    );
    return json({ room: this.meta(), members: this.membersWithPresence() });
  }

  private state(actor: Actor | null): Response {
    const room = this.meta();
    if (!room) return json({ error: "room not initialized" }, 404);
    if (!actor) return json({ error: "unauthorized" }, 401);
    this.requireMember(actor);
    return json({ room, members: this.membersWithPresence() });
  }

  private listMessages(actor: Actor | null, url: URL): Response {
    if (!actor) return json({ error: "unauthorized" }, 401);
    this.requireMember(actor);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 80)));
    const before = Number(url.searchParams.get("before") || 0);
    const rows = (
      before
        ? this.ctx.storage.sql.exec(
            "SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
            before,
            limit,
          )
        : this.ctx.storage.sql.exec(
            "SELECT * FROM messages ORDER BY created_at DESC LIMIT ?",
            limit,
          )
    ).toArray() as Record<string, unknown>[];
    const room = this.meta();
    const messages = rows
      .map((row) => forRecipient(rowToMessage(row, room?.id || ""), actor))
      .reverse();
    return json({
      messages,
      // Repeated in the body because plenty of clients never look at headers.
      content: "untrusted-user-content",
      guide: "/api/agent-guide",
    });
  }

  private postMessage(actor: Actor | null, body: { text?: string; attachments?: Attachment[] }): Response {
    if (!actor) return json({ error: "unauthorized" }, 401);
    const member = this.requireMember(actor);
    const text = (body.text || "").trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!text && attachments.length === 0) {
      throw new HttpError(400, "message needs text or an attachment");
    }
    if (text.length > 8000) throw new HttpError(400, "text too long (max 8000)");
    if (attachments.length > 8) throw new HttpError(400, "too many attachments");
    const room = this.meta();
    if (!room) throw new HttpError(404, "room not initialized");
    const message: Message = {
      id: id("msg"),
      room_id: room.id,
      author_id: member.id,
      author_name: member.name,
      author_kind: member.kind,
      author_role: member.role,
      text,
      attachments,
      created_at: Date.now(),
      mentions: extractMentions(text),
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO messages
        (id, author_id, author_name, author_kind, author_role, text, attachments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      message.author_id,
      message.author_name,
      message.author_kind,
      message.author_role,
      message.text,
      JSON.stringify(message.attachments),
      message.created_at,
    );
    // mentions_you differs per recipient, so each socket gets its own copy
    // rather than one shared payload every client has to re-evaluate.
    this.broadcastPerSocket((recipient) => ({
      type: "message",
      message: forRecipient(message, recipient),
    }));
    return json({ message: forRecipient(message, member) }, 201);
  }

  private addMember(actor: Actor | null, body: Actor & { invite_code?: string }): Response {
    const room = this.meta();
    if (!room) throw new HttpError(404, "room not initialized");
    const existing = this.ctx.storage.sql
      .exec("SELECT id FROM members WHERE id = ?", body.id)
      .toArray()[0];
    if (existing) {
      return json({ member: this.members().find((m) => m.id === body.id), joined: false });
    }
    const invitedByMember = actor ? this.members().some((m) => m.id === actor.id) : false;
    const codeOk = body.invite_code && body.invite_code === room.invite_code;
    if (!codeOk && !invitedByMember) {
      throw new HttpError(403, "valid invite code or existing member required");
    }
    const now = Date.now();
    const role = body.role || (body.kind === "bot" ? "agent" : "member");
    this.ctx.storage.sql.exec(
      "INSERT INTO members (id, kind, name, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      body.id,
      body.kind,
      body.name,
      role,
      now,
    );
    const member: Member = {
      id: body.id,
      kind: body.kind,
      name: body.name,
      role,
      joined_at: now,
      online: false,
    };
    this.broadcast({ type: "member_joined", member });
    return json({ member, joined: true }, 201);
  }

  private typing(actor: Actor | null): Response {
    if (!actor) return json({ error: "unauthorized" }, 401);
    this.requireMember(actor);
    this.broadcast({
      type: "typing",
      actor_id: actor.id,
      actor_name: actor.name,
      actor_kind: actor.kind,
    });
    return json({ ok: true });
  }

  private async destroy(actor: Actor | null): Promise<Response> {
    if (!actor) return json({ error: "unauthorized" }, 401);
    const room = this.meta();
    if (!room) return json({ deleted: true, attachment_keys: [] });
    const isMember = this.members().some((m) => m.id === actor.id);
    if (!canDeleteRoom(actor, room, isMember)) {
      throw new HttpError(403, "only the creator or a human member can delete this room");
    }
    const keys = new Set<string>();
    const rows = this.ctx.storage.sql.exec("SELECT attachments FROM messages").toArray() as {
      attachments: string;
    }[];
    for (const row of rows) {
      try {
        const list = JSON.parse(row.attachments) as Attachment[];
        for (const a of list) if (a.key) keys.add(a.key);
      } catch {
        /* ignore bad rows */
      }
    }
    const payload = JSON.stringify({ type: "room_deleted", room_id: room.id });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
        ws.close(1000, "room_deleted");
      } catch {
        /* already closed */
      }
    }
    this.ready = false;
    await this.ctx.storage.deleteAll();
    return json({ deleted: true, room_id: room.id, attachment_keys: [...keys] });
  }

  private acceptSocket(request: Request): Response {
    const actor = readActor(request);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const room = this.meta();
    if (!room) return json({ error: "room not initialized" }, 404);
    this.requireMember(actor);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [actor.id]);
    pair[1].serializeAttachment({ actor });
    this.broadcast(
      { type: "presence", members: this.membersWithPresence() },
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.ensureTables();
    if (typeof raw !== "string") return;
    let data: { type?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const attachment = ws.deserializeAttachment() as { actor?: Actor } | null;
    const actor = attachment?.actor;
    if (!actor) return;
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (data.type === "typing") {
      try {
        this.requireMember(actor);
      } catch {
        return;
      }
      this.broadcast(
        {
          type: "typing",
          actor_id: actor.id,
          actor_name: actor.name,
          actor_kind: actor.kind,
        },
        ws,
      );
    }
  }

  async webSocketClose(): Promise<void> {
    this.ensureTables();
    if (!this.meta()) return;
    this.broadcast({ type: "presence", members: this.membersWithPresence() });
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readActor(request: Request): Actor | null {
  const raw = request.headers.get("X-Partyline-Actor");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Actor;
  } catch {
    return null;
  }
}

function rowToMessage(row: Record<string, unknown>, roomId: string): Message {
  let attachments: Attachment[] = [];
  try {
    attachments = JSON.parse(String(row.attachments || "[]")) as Attachment[];
  } catch {
    attachments = [];
  }
  return {
    id: String(row.id),
    room_id: roomId,
    author_id: String(row.author_id),
    author_name: String(row.author_name),
    author_kind: row.author_kind as Message["author_kind"],
    author_role: String(row.author_role),
    text: String(row.text || ""),
    attachments,
    created_at: Number(row.created_at),
    // Derived on read rather than stored, so messages written before mentions
    // existed gain them too, and a stored copy can never disagree with `text`.
    mentions: extractMentions(String(row.text || "")),
  };
}

/** Stamp a message with whether it addresses this particular reader. */
function forRecipient(message: Message, recipient: { name: string }): Message {
  return { ...message, mentions_you: mentionsMember(message.mentions, recipient.name) };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
