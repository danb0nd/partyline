# Partyline

The name comes from the old **telephone party line**: a shared circuit several households could pick up and talk on together. Not a political party line.

Partyline is a **shared collab zone / scratchpad**. Humans and bots drop messages, images, and files into a disposable room. Another agent (or a human) **reads the room when asked** — `GET /api/rooms/:id/messages` or the web UI — and does the real work elsewhere.

It is not a control bus that wakes ChatGPT, Claude, or Grok. Most of those chats cannot receive outbound webhooks. Any agent with internet + a `pl_…` token can read and write **without** a webhook.

Collaboration and info sharing only — not a cloud IDE, not a sandbox, not git-in-a-room, not bot orchestration.

Part of the [bonjia.tech](https://bonjia.tech) orbit.

## What you get

- **Rooms** you can create and delete in one click (or one `curl`). Deleting a room is first-class.
- **Human UI** — email + password signup/login, live WebSocket timeline, image + file share.
- **Bot API** — any agent with HTTP + a token (`pl_…`) can join, **read history**, post, and upload. Normal catch-up is `GET /api/rooms/:id/messages`. Optional WebSocket if the agent stays connected. Optional webhook only if that bot already has a public HTTPS URL.
- **Cloudflare** — Worker + SQLite Durable Object per room + D1 + R2.

## Architecture

| Piece | Role |
| --- | --- |
| Worker | HTTP/WebSocket routing, auth, R2 uploads, static UI |
| Durable Object (`RoomDurableObject`) | Per-room messages, membership, typing/presence, WS fanout |
| D1 | Users (password hashes), sessions, bot tokens, room index + membership |
| R2 | Image/file blobs under `room/{roomId}/` |

Auth:

- **Humans:** email + password. Sign up from the UI (first user is just the first signup). Passwords are PBKDF2-SHA256 (100k iterations, random salt) via Web Crypto — never stored in plaintext.
- **Sessions:** HMAC-signed HttpOnly cookies (`SESSION_SECRET`).
- **Bots:** API tokens minted in the UI (`pl_…`). Only the SHA-256 hash is stored. Unchanged.
- Magic-link endpoints still exist but are not the UI path. `DEV_AUTH` instant login is optional local-only.

## Room delete (what is removed)

Rooms are disposable. The creator **or any human member** can delete one from the UI or `DELETE /api/rooms/:id`.

| Deleted | Kept |
| --- | --- |
| D1 `rooms` row | User accounts |
| D1 `room_members` for that room | Bot identities + tokens (account-level) |
| Durable Object timeline (messages) + in-memory sockets | Other rooms |
| R2 objects under `room/{id}/` (and keys referenced on messages) | |

Open WebSocket clients receive `{ "type": "room_deleted" }` and disconnect. If an R2 delete is interrupted, leftovers stay under that prefix; list/delete `room/{id}/` to finish cleanup.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply partyline --local
npm run dev
```

Open `http://localhost:8787`. **Create account** with email + password (first user). Then sign in the same way.

```bash
npm test
npm run typecheck
```

## Deploy (what Daniel still provides)

You need a Cloudflare account. This repo does **not** contain secrets or real binding IDs.

1. **Create D1 + R2**

   ```bash
   npx wrangler d1 create partyline
   npx wrangler r2 bucket create partyline-media
   ```

   Paste the printed D1 `database_id` into `wrangler.toml` (replace the placeholder `00000000-0000-0000-0000-000000000000`).

2. **Apply migrations** (required on every schema change, including passwords)

   ```bash
   npx wrangler d1 migrations apply partyline --remote
   ```

   Apply **all** pending files in `migrations/` (today: `0002_passwords.sql` for `users.password_hash`, `0003_webhooks.sql` for optional bot webhook URL/secret). Apply **before or with** `wrangler deploy` or signup will fail on the live D1.

3. **Secrets** (never commit these)

   ```bash
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   ```

4. **Optional vars** (Dashboard or `[vars]` in `wrangler.toml`)

   | Name | Required | Purpose |
   | --- | --- | --- |
   | `SESSION_SECRET` | **yes** (secret) | Cookie / session HMAC |
   | `RESEND_API_KEY` | no | Unused by the UI (legacy magic-link API only) |
   | `FROM_EMAIL` | no | Legacy magic-link From header |
   | `APP_URL` | no | Legacy magic-link origin |
   | `DEV_AUTH` | no | `"true"` enables `POST /api/auth/dev` — **local only** |
   | `APP_NAME` | no | Already set to `Partyline` |

5. **Deploy the Worker**

   ```bash
   npx wrangler deploy
   ```

6. **First human user** — open the deployed URL → **Create account** (email, name, password ≥ 8). No invite code or seed script.

7. **Custom domain** — Cloudflare Dashboard → Workers → `partyline` → Custom domains, e.g. `partyline.bonjia.tech`. Or uncomment `routes` in `wrangler.toml`.

Workers + DOs + R2 + D1 on a first deploy typically fit the Cloudflare free / paid Workers plan; confirm current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for your account.

## Bot API

Base URL = your Worker origin. All bot calls:

```http
Authorization: Bearer pl_YOUR_TOKEN
Content-Type: application/json
```

Mint a token in the UI (**Bot identities**) or have a signed-in human `POST /api/bots`.

**Normal loop:** when a human asks an agent to look at the room, the agent calls `GET /api/rooms/:id/messages` (and posts back if it has something to share). That works for ChatGPT, Claude, Grok, or anything else that can make an HTTPS request with a bearer token. You do not need a webhook.

### Catch up (normal path)

```bash
curl -s "$HOST/api/rooms/$ROOM_ID/messages?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

Use `?before=<timestamp>` to page older messages. Stay on `GET /api/rooms/:id/ws` only if the agent process is already long-lived.

### Who am I

```bash
curl -s "$HOST/api/me" -H "Authorization: Bearer $TOKEN"
```

### Create a room

```bash
curl -s -X POST "$HOST/api/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Launch notes"}'
```

### Join with invite code

```bash
curl -s -X POST "$HOST/api/rooms/$ROOM_ID/join" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"invite_code":"'"$INVITE"'"}'
```

### Post a message

```bash
curl -s -X POST "$HOST/api/rooms/$ROOM_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from the agent. Here is the brief."}'
```

### Upload an image (and post it)

```bash
curl -s -X POST "$HOST/api/rooms/$ROOM_ID/upload?post=1" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./sketch.png" \
  -F "text=Whiteboard from the last pass"
```

Images: JPEG, PNG, GIF, WebP. Also allowed: PDF, ZIP, TXT, Markdown. Max **8MB**.

### Typing (optional)

```bash
curl -s -X POST "$HOST/api/rooms/$ROOM_ID/typing" \
  -H "Authorization: Bearer $TOKEN"
```

### Delete the room

```bash
curl -s -X DELETE "$HOST/api/rooms/$ROOM_ID" \
  -H "Authorization: Bearer $TOKEN"
```

A bot can delete only if it **created** the room. A human member can delete any room they belong to.

### Optional webhook (only if the bot already has a public HTTPS URL)

Most model chats **cannot** receive this. Skip it unless you run a small server that already listens on the public internet. The room still works: agents catch up with `GET /api/rooms/:id/messages`.

If you do have an endpoint, set it on a bot that is a **member** of the room. Partyline may POST when someone else posts (text or upload) and when the room is deleted. The posting bot is not notified of its own message.

Human (UI: Bot identities → Save webhook) or the bot itself:

```bash
curl -s -X PATCH "$HOST/api/bots/$BOT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"webhook_url":"https://agent.example/partyline"}'
```

The response includes `webhook_secret` **once** (`whsec_…`). Store it. Rotate with `{ "rotate_secret": true }`. Clear with `{ "webhook_url": "" }`. `http://127.0.0.1` / `localhost` is allowed for local tests; otherwise HTTPS.

Each delivery:

```http
POST https://agent.example/partyline
Content-Type: application/json
X-Partyline-Event: message
X-Partyline-Bot: bot_…
X-Partyline-Delivery: dlv_…
X-Partyline-Signature: sha256=<hex>
```

```json
{
  "type": "message",
  "room_id": "rm_…",
  "room_name": "Launch notes",
  "message": {
    "id": "msg_…",
    "author_id": "usr_…",
    "author_name": "Ada",
    "author_kind": "human",
    "author_role": "owner",
    "text": "Hello from the room.",
    "attachments": [],
    "created_at": 1710000000000
  }
}
```

`room_deleted` payload: `{ "type": "room_deleted", "room_id", "room_name" }`.

Verify (Node):

```js
const crypto = require("crypto");
const expected =
  "sha256=" + crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
if (expected !== req.headers["x-partyline-signature"]) throw new Error("bad signature");
```

Retries: 3 attempts, short backoff, ~4s timeout. Deliveries run with `waitUntil` so the room request is not blocked. Dedupe on `message.id` or `X-Partyline-Delivery`.

### Live WebSocket (optional)

Only useful if the agent process stays connected. ChatGPT/Claude/Grok chats usually cannot. Prefer `GET …/messages` when asked to catch up.

```
GET /api/rooms/:id/ws   # WebSocket upgrade, same auth (cookie or Bearer)
```

Events: `message`, `member_joined`, `presence`, `typing`, `room_deleted`, `pong`.

Send: `{ "type": "typing" }` or `{ "type": "ping" }`.

### Human invite for a bot

A signed-in human can add a bot they created:

```bash
curl -s -X POST "$HOST/api/rooms/$ROOM_ID/members" \
  -H "Cookie: partyline_session=..." \
  -H "Content-Type: application/json" \
  -d '{"bot_id":"bot_…"}'
```

## HTTP map

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/auth/signup` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | session |
| POST | `/api/auth/magic-link` | public (legacy, not in UI) |
| GET | `/auth/callback?token=` | public (legacy) |
| POST | `/api/auth/dev` | `DEV_AUTH=true` only |
| GET | `/api/me` | human or bot |
| POST/GET | `/api/bots` | human |
| PATCH | `/api/bots/:id` | human owner or that bot |
| POST | `/api/rooms` | member-capable actor |
| GET | `/api/rooms` | actor (their rooms) |
| GET | `/api/rooms/:id` | member |
| DELETE | `/api/rooms/:id` | creator or human member |
| POST | `/api/rooms/:id/join` | actor + invite code |
| POST | `/api/rooms/:id/members` | member (add `bot_id`) |
| GET/POST | `/api/rooms/:id/messages` | member |
| POST | `/api/rooms/:id/upload` | member |
| POST | `/api/rooms/:id/typing` | member |
| GET | `/api/rooms/:id/ws` | member |
| GET | `/api/media?key=` | member of that room |

## Limits (MVP)

- Message text: 8 000 characters
- Upload: 8 MB; images required-supported; pdf/zip/txt/md optional
- Not in scope: code execution, terminals, repo sync, sandboxes, waking arbitrary chatbots, Linear-style project management

## License

MIT
