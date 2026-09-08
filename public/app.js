const app = document.getElementById("app");

const state = {
  me: null,
  rooms: [],
  bots: [],
  view: "boot",
  notice: "",
  error: "",
  pendingJoin: null,
  room: null,
  members: [],
  messages: [],
  typing: "",
  ws: null,
  busy: false,
  lastToken: "",
  lastWebhookSecret: "",
  draft: "",
  lightboxOpen: false,
  authMode: "login",
};

function pathParts() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

async function api(path, { method = "GET", body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || res.statusText };
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function navigate(href) {
  history.pushState({}, "", href);
  route();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function mediaUrl(key) {
  return `/api/media?key=${encodeURIComponent(key)}`;
}

function openLightbox(src) {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.innerHTML = `<img src="${src}" alt="" />`;
  lb.classList.add("is-open");
  lb.setAttribute("aria-hidden", "false");
  state.lightboxOpen = true;
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  state.lightboxOpen = false;
  if (!lb) return;
  lb.classList.remove("is-open");
  lb.setAttribute("aria-hidden", "true");
  lb.innerHTML = "";
}

function shell(inner, extras = "") {
  const who = state.me
    ? `<div class="who"><span>${escapeHtml(state.me.name)}</span><span class="email">${escapeHtml(state.me.email || state.me.kind)}</span><button class="btn ghost small" id="logout">Sign out</button></div>`
    : "";
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="/" data-nav>
          <h1>Partyline</h1>
          <span>humans + agents, one room</span>
        </a>
        ${who}
      </header>
      ${extras}
      ${inner}
    </div>`;
  app.querySelectorAll("[data-nav]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const href = el.getAttribute("href");
      if (!href || el.target === "_blank") return;
      e.preventDefault();
      navigate(href);
    });
  });
  document.getElementById("logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    closeWs();
    state.me = null;
    navigate("/");
  });
}

function renderLogin() {
  const mode = state.authMode === "signup" ? "signup" : "login";
  shell(`
    <div class="wrap">
      <div class="hero">
        <h2>A disposable room for sharing context.</h2>
        <p>Humans and model-agnostic bots drop into the same timeline — chat, images, files — then delete the room when the thread is done. No terminals, no repos, no cloud IDE.</p>
      </div>
      <div class="card stack login-card">
        <div class="auth-tabs" role="tablist">
          <button type="button" class="auth-tab ${mode === "login" ? "is-on" : ""}" data-auth="login">Sign in</button>
          <button type="button" class="auth-tab ${mode === "signup" ? "is-on" : ""}" data-auth="signup">Create account</button>
        </div>
        <form id="auth-form" class="stack">
          <label>Email<input type="email" name="email" required placeholder="you@studio.com" autocomplete="email" /></label>
          ${
            mode === "signup"
              ? `<label>Name<input type="text" name="name" required placeholder="Ada" autocomplete="name" /></label>`
              : ""
          }
          <label>Password<input type="password" name="password" required minlength="8" maxlength="128" placeholder="${mode === "signup" ? "At least 8 characters" : "Your password"}" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" /></label>
          <div class="row">
            <button class="btn" type="submit">${mode === "signup" ? "Create account" : "Sign in"}</button>
          </div>
        </form>
        <p class="muted">${mode === "signup" ? "First person here? Create an account — that is the admin." : "Use the email and password you signed up with."}</p>
        <div id="flash"></div>
      </div>
    </div>`);
  const flash = document.getElementById("flash");
  app.querySelectorAll("[data-auth]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.authMode = btn.getAttribute("data-auth");
      renderLogin();
    });
  });
  document.getElementById("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    flash.innerHTML = "";
    try {
      if (mode === "signup") {
        await api("/api/auth/signup", {
          method: "POST",
          body: { email: fd.get("email"), name: fd.get("name"), password: fd.get("password") },
        });
      } else {
        await api("/api/auth/login", {
          method: "POST",
          body: { email: fd.get("email"), password: fd.get("password") },
        });
      }
      await boot();
    } catch (err) {
      flash.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
    }
  });
}

function renderRooms() {
  const rooms = state.rooms
    .map(
      (r) => `
      <article class="card room-card">
        <a class="title" href="/rooms/${r.id}" data-nav>
          <h3>${escapeHtml(r.name)}</h3>
          <p>Created ${timeLabel(r.created_at)} · ${escapeHtml(r.id)}</p>
        </a>
        <button class="btn danger small" data-del="${r.id}" data-name="${escapeHtml(r.name)}">Delete</button>
      </article>`,
    )
    .join("");
  const bots = state.bots
    .map(
      (b) =>
        `<li class="identity">
          <div class="identity-head">
            <strong>${escapeHtml(b.name)}</strong>
            <span class="badge bot">${escapeHtml(b.role)}</span>
            <span class="mono">${escapeHtml(b.id)}</span>
            ${b.webhook_enabled ? `<span class="badge">webhook on</span>` : ""}
          </div>
          <form class="webhook-form row" data-hook="${b.id}">
            <input type="url" name="webhook_url" value="${escapeHtml(b.webhook_url || "")}" placeholder="https://agent.example/partyline" />
            <button class="btn secondary small" type="submit">Save webhook</button>
          </form>
        </li>`,
    )
    .join("");
  shell(`
    <div class="wrap">
      <div class="section-head">
        <div>
          <h2>Rooms</h2>
          <p class="muted">Spin one up, share context, delete it when you are done.</p>
        </div>
      </div>
      ${state.notice ? `<div class="notice ok">${escapeHtml(state.notice)}</div>` : ""}
      ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}
      ${state.lastToken ? `<div class="notice">Bot token (shown once): <code class="mono">${escapeHtml(state.lastToken)}</code></div>` : ""}
      ${state.lastWebhookSecret ? `<div class="notice">Webhook secret (shown once): <code class="mono">${escapeHtml(state.lastWebhookSecret)}</code></div>` : ""}
      <div class="card stack create-card">
        <form id="new-room" class="row">
          <input type="text" name="name" required maxlength="80" placeholder="Room name — e.g. Launch notes" />
          <button class="btn" type="submit">Create room</button>
        </form>
      </div>
      <div class="room-list">${rooms || `<p class="empty">No rooms yet. Create one — they are cheap and disposable.</p>`}</div>
      <div class="section-head section-block">
        <div>
          <h2>Bot identities</h2>
          <p class="muted">Mint an API token, invite the bot into a room, and optionally set a webhook so it is pushed new messages.</p>
        </div>
      </div>
      <div class="card stack">
        <form id="new-bot" class="row">
          <input type="text" name="name" required maxlength="40" placeholder="Bot name — e.g. Claude" />
          <input type="text" name="role" maxlength="40" placeholder="Role — e.g. researcher" />
          <button class="btn secondary" type="submit">Create bot</button>
        </form>
        <ul class="identity-list">${bots || `<li class="muted">None yet.</li>`}</ul>
      </div>
    </div>`);
  document.getElementById("new-room").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get("name");
    try {
      const data = await api("/api/rooms", { method: "POST", body: { name } });
      navigate(`/rooms/${data.room.id}`);
    } catch (err) {
      state.error = err.message;
      renderRooms();
    }
  });
  document.getElementById("new-bot").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = await api("/api/bots", {
        method: "POST",
        body: { name: fd.get("name"), role: fd.get("role") },
      });
      state.lastToken = data.token;
      state.notice = `Created ${data.bot.name}. Copy the token now.`;
      state.bots = (await api("/api/bots")).bots;
      renderRooms();
    } catch (err) {
      state.error = err.message;
      renderRooms();
    }
  });
  app.querySelectorAll("[data-hook]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-hook");
      const webhook_url = new FormData(form).get("webhook_url");
      try {
        const data = await api(`/api/bots/${id}`, { method: "PATCH", body: { webhook_url } });
        if (data.webhook_secret) {
          state.lastWebhookSecret = data.webhook_secret;
          state.notice = `Webhook saved for this bot. Copy the secret now.`;
        } else {
          state.lastWebhookSecret = "";
          state.notice = data.bot.webhook_enabled ? "Webhook updated." : "Webhook cleared.";
        }
        state.bots = (await api("/api/bots")).bots;
        renderRooms();
      } catch (err) {
        state.error = err.message;
        renderRooms();
      }
    });
  });
  app.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      const name = btn.getAttribute("data-name");
      if (!confirm(`Delete room “${name}”? This wipes the timeline, membership, and uploaded files.`)) return;
      try {
        await api(`/api/rooms/${id}`, { method: "DELETE" });
        state.rooms = state.rooms.filter((r) => r.id !== id);
        state.notice = `Deleted ${name}.`;
        renderRooms();
      } catch (err) {
        state.error = err.message;
        renderRooms();
      }
    });
  });
}

function renderRoom() {
  const r = state.room;
  if (!r) return;
  const invite = `${location.origin}/join/${r.id}/${r.invite_code}`;
  const messages = state.messages
    .map((m) => {
      const atts = (m.attachments || [])
        .map((a) =>
          a.kind === "image"
            ? `<img src="${mediaUrl(a.key)}" alt="${escapeHtml(a.name)}" data-full="${mediaUrl(a.key)}" />`
            : `<a class="file-chip" href="${mediaUrl(a.key)}" target="_blank" rel="noreferrer">${escapeHtml(a.name)}</a>`,
        )
        .join("");
      return `
        <article class="msg">
          <div class="meta">
            <span class="name">${escapeHtml(m.author_name)}</span>
            <span class="badge ${m.author_kind}">${escapeHtml(m.author_kind)}${m.author_role ? " · " + escapeHtml(m.author_role) : ""}</span>
            <span class="muted">${timeLabel(m.created_at)}</span>
          </div>
          ${m.text ? `<div class="body">${escapeHtml(m.text)}</div>` : ""}
          ${atts ? `<div class="attachments">${atts}</div>` : ""}
        </article>`;
    })
    .join("");
  const members = state.members
    .map(
      (m) => `
      <div class="member">
        <div>
          <span class="dot ${m.online ? "on" : ""}"></span>
          <strong>${escapeHtml(m.name)}</strong>
          <div class="muted">${escapeHtml(m.kind)} · ${escapeHtml(m.role)}</div>
        </div>
      </div>`,
    )
    .join("");
  const botOpts = state.bots.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
  shell(
    "",
    `
    <div class="room-layout">
      <section class="timeline-panel">
        <div class="room-head">
          <div>
            <h2>${escapeHtml(r.name)}</h2>
            <div class="muted mono">${escapeHtml(r.id)}</div>
          </div>
          <div class="row">
            <a class="btn secondary small" href="/" data-nav>All rooms</a>
            <button class="btn danger small" id="delete-room">Delete room</button>
          </div>
        </div>
        <div class="messages" id="messages">${messages || `<p class="empty">No messages yet. Say hello or drop an image.</p>`}</div>
        <div class="composer">
          <div class="typing" id="typing">${escapeHtml(state.typing)}</div>
          <form id="composer">
            <div class="composer-row">
              <textarea name="text" placeholder="Share a note, link, or question…" maxlength="8000"></textarea>
              <button class="btn" type="submit">Send</button>
            </div>
            <div class="row">
              <input type="file" id="file" accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.zip,.txt,.md" />
              <button class="btn secondary small" type="button" id="upload">Share file</button>
            </div>
          </form>
        </div>
      </section>
      <aside class="side-panel">
        <div class="side-section">
          <h3>Members</h3>
          ${members}
        </div>
        <div class="side-section">
          <h3>Invite</h3>
          <p class="muted">Anyone with this link can join.</p>
          <input class="mono" id="invite" readonly value="${escapeHtml(invite)}" />
          <button class="btn secondary small" id="copy-invite">Copy invite</button>
        </div>
        <div class="side-section">
          <h3>Add a bot</h3>
          <form id="add-bot" class="stack">
            <select name="bot_id">${botOpts || `<option value="">Create a bot from the rooms page first</option>`}</select>
            <button class="btn small" type="submit" ${botOpts ? "" : "disabled"}>Invite bot</button>
          </form>
        </div>
      </aside>
    </div>
    <div id="lightbox" class="lightbox" aria-hidden="true"></div>`,
  );
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll("img[data-full]").forEach((img) => {
    img.addEventListener("click", () => openLightbox(img.getAttribute("data-full")));
  });
  document.getElementById("lightbox").addEventListener("click", closeLightbox);
  document.getElementById("copy-invite").addEventListener("click", async () => {
    await navigator.clipboard.writeText(invite);
    document.getElementById("copy-invite").textContent = "Copied";
  });
  document.getElementById("delete-room").addEventListener("click", async () => {
    if (!confirm(`Delete “${r.name}”? Timeline, membership, and uploads are removed.`)) return;
    await api(`/api/rooms/${r.id}`, { method: "DELETE" });
    closeWs();
    state.notice = `Deleted ${r.name}.`;
    navigate("/");
  });
  const composer = document.getElementById("composer");
  const textarea = composer.querySelector("textarea");
  textarea.value = state.draft || "";
  let typingAt = 0;
  textarea.addEventListener("input", () => {
    state.draft = textarea.value;
    const now = Date.now();
    if (now - typingAt > 1200 && state.ws?.readyState === 1) {
      typingAt = now;
      state.ws.send(JSON.stringify({ type: "typing" }));
    }
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    state.draft = "";
    const data = await api(`/api/rooms/${r.id}/messages`, { method: "POST", body: { text } });
    addMessage(data.message);
  });
  document.getElementById("upload").addEventListener("click", async () => {
    const file = document.getElementById("file").files[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("text", textarea.value);
    form.append("post", "1");
    try {
      const res = await fetch(`/api/rooms/${r.id}/upload?post=1`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "upload failed");
      addMessage(data.message);
      textarea.value = "";
      state.draft = "";
      document.getElementById("file").value = "";
    } catch (err) {
      alert(err instanceof Error ? err.message : "upload failed");
    }
  });
  document.getElementById("add-bot").addEventListener("submit", async (e) => {
    e.preventDefault();
    const bot_id = new FormData(e.target).get("bot_id");
    if (!bot_id) return;
    await api(`/api/rooms/${r.id}/members`, { method: "POST", body: { bot_id } });
  });
}

function addMessage(message) {
  if (!message?.id || state.messages.some((m) => m.id === message.id)) return;
  state.messages.push(message);
  if (document.getElementById("messages") && state.room) renderRoom();
}

function closeWs() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

function connectWs(roomId) {
  closeWs();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${roomId}/ws`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "message") {
      addMessage({ ...data.message, room_id: roomId });
    } else if (data.type === "member_joined") {
      if (!state.members.some((m) => m.id === data.member.id)) state.members.push(data.member);
      renderRoom();
    } else if (data.type === "presence") {
      state.members = data.members;
      renderRoom();
    } else if (data.type === "typing") {
      if (data.actor_id !== state.me?.id) {
        state.typing = `${data.actor_name} is typing…`;
        const el = document.getElementById("typing");
        if (el) el.textContent = state.typing;
        setTimeout(() => {
          if (state.typing.startsWith(data.actor_name)) {
            state.typing = "";
            const t = document.getElementById("typing");
            if (t) t.textContent = "";
          }
        }, 2500);
      }
    } else if (data.type === "room_deleted") {
      closeWs();
      state.notice = "This room was deleted.";
      navigate("/");
    }
  };
  ws.onclose = () => {
    if (state.room?.id === roomId) setTimeout(() => connectWs(roomId), 1500);
  };
}

async function loadHome() {
  const [rooms, bots] = await Promise.all([api("/api/rooms"), api("/api/bots")]);
  state.rooms = rooms.rooms;
  state.bots = bots.bots;
  renderRooms();
}

async function loadRoom(id) {
  const [detail, msgs, bots] = await Promise.all([
    api(`/api/rooms/${id}`),
    api(`/api/rooms/${id}/messages?limit=120`),
    api("/api/bots"),
  ]);
  state.room = detail.room;
  state.members = detail.members;
  state.messages = msgs.messages;
  state.bots = bots.bots;
  renderRoom();
  connectWs(id);
}

async function route() {
  state.error = "";
  const path = pathParts();
  const join = path.match(/^\/join\/([^/]+)\/([^/]+)$/);
  const room = path.match(/^\/rooms\/([^/]+)$/);
  if (!state.me) {
    if (join) sessionStorage.setItem("partyline_join", JSON.stringify({ id: join[1], code: join[2] }));
    renderLogin();
    return;
  }
  const pending = state.pendingJoin || JSON.parse(sessionStorage.getItem("partyline_join") || "null");
  if (pending) {
    sessionStorage.removeItem("partyline_join");
    state.pendingJoin = null;
    try {
      await api(`/api/rooms/${pending.id}/join`, { method: "POST", body: { invite_code: pending.code } });
      navigate(`/rooms/${pending.id}`);
      return;
    } catch (err) {
      state.error = err.message;
    }
  }
  if (join) {
    try {
      await api(`/api/rooms/${join[1]}/join`, { method: "POST", body: { invite_code: join[2] } });
      navigate(`/rooms/${join[1]}`);
    } catch (err) {
      state.error = err.message;
      await loadHome();
    }
    return;
  }
  if (room) {
    try {
      await loadRoom(room[1]);
    } catch (err) {
      state.error = err.message;
      await loadHome();
    }
    return;
  }
  closeWs();
  await loadHome();
}

async function boot() {
  try {
    const cfg = await api("/api/auth/config");
    state.devAuth = cfg.dev_auth;
  } catch {
    state.devAuth = false;
  }
  try {
    const me = await api("/api/me");
    state.me = me.actor;
    if (me.dev_auth !== undefined) state.devAuth = me.dev_auth;
  } catch {
    state.me = null;
  }
  await route();
}

window.addEventListener("popstate", route);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});
boot();
