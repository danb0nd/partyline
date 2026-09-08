import { toHex } from "./crypto";
import { randomHex } from "./ids";
import type { Env, Message } from "./types";

export interface WebhookTarget {
  id: string;
  name: string;
  webhook_url: string;
  webhook_secret: string;
}

export type WebhookEvent =
  | {
      type: "message";
      room_id: string;
      room_name: string;
      message: Message;
    }
  | {
      type: "room_deleted";
      room_id: string;
      room_name: string;
    };

const ATTEMPTS = 3;
const TIMEOUT_MS = 4000;
const BACKOFF_MS = [0, 150, 400];

export function newWebhookSecret(): string {
  return `whsec_${randomHex(24)}`;
}

export function validateWebhookUrl(raw: string): { ok: true; url: string | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, url: null };
  if (trimmed.length > 2048) return { ok: false, error: "webhook URL too long" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid webhook URL" };
  }
  const https = parsed.protocol === "https:";
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (!https && !localHttp) {
    return { ok: false, error: "webhook URL must be https (http only for localhost)" };
  }
  return { ok: true, url: parsed.toString() };
}

export async function signWebhookBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${toHex(sig)}`;
}

export async function listWebhookTargets(
  env: Env,
  roomId: string,
  exceptActorId?: string,
): Promise<WebhookTarget[]> {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.name, b.webhook_url, b.webhook_secret
     FROM bots b
     JOIN room_members m ON m.actor_id = b.id AND m.room_id = ?
     WHERE b.webhook_url IS NOT NULL AND b.webhook_url != ''
       AND b.webhook_secret IS NOT NULL AND b.webhook_secret != ''`,
  )
    .bind(roomId)
    .all<WebhookTarget>();
  return (rows.results || []).filter((t) => t.id !== exceptActorId);
}

export async function notifyRoomBots(
  env: Env,
  roomId: string,
  event: WebhookEvent,
  exceptActorId?: string,
): Promise<void> {
  const targets = await listWebhookTargets(env, roomId, exceptActorId);
  await dispatchWebhooks(targets, event);
}

export async function dispatchWebhooks(targets: WebhookTarget[], event: WebhookEvent): Promise<void> {
  await Promise.all(targets.map((t) => deliverWithRetry(t, event)));
}

async function deliverWithRetry(target: WebhookTarget, event: WebhookEvent): Promise<void> {
  const body = JSON.stringify(event);
  const signature = await signWebhookBody(body, target.webhook_secret);
  const delivery = `dlv_${randomHex(8)}`;
  for (let i = 0; i < ATTEMPTS; i++) {
    if (BACKOFF_MS[i]) await sleep(BACKOFF_MS[i]);
    try {
      const res = await fetch(target.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Partyline-Event": event.type,
          "X-Partyline-Bot": target.id,
          "X-Partyline-Delivery": delivery,
          "X-Partyline-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return;
    } catch {
      /* retry */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
