// Cloudflare Worker (free plan) + KV namespace "DB". Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_KEY, RUNNER_TOKEN
// Routes: / landing, /auth/login, /auth/callback, /dashboard, /api/settings, /api/due (runner only), /api/log (runner only), /auth/logout
const NICHES = { quran: "Quran & Adhkar", motivation: "Daily Motivation" };
const SLOTS = ["14:00", "19:00", "23:00"]; // Cairo times the runner maps to slot 0..2
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8)), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function key(env) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(env.SESSION_KEY)), "AES-GCM", false, ["encrypt", "decrypt"]); }
export async function seal(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(text))); return b64(iv) + "." + b64(ct); }
export async function unseal(env, s) { const [i, c] = s.split("."); return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(i) }, await key(env), unb64(c))); }
async function hmac(env, data) { const k = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)))); }
async function sessionUser(env, req) {
  const m = (req.headers.get("cookie") || "").match(/sid=([^;]+)/); if (!m) return null;
  const [id, sig] = decodeURIComponent(m[1]).split("|"); return id && sig === (await hmac(env, id)) ? id : null;
}
const page = (body, status = 200, extra = {}) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Auto Shorts</title><style>body{font-family:system-ui,sans-serif;margin:0;background:linear-gradient(160deg,#0b3d3a,#1b2a6b);color:#fff8e1;min-height:100vh;display:grid;place-items:center}main{max-width:560px;padding:28px;width:100%}.card{background:#ffffff14;border-radius:14px;padding:18px;margin:14px 0}.btn,button{background:#d4af5a;color:#0b2a30;border:0;padding:12px 22px;border-radius:10px;font-weight:700;text-decoration:none;display:inline-block;cursor:pointer}select,label{font-size:1rem}</style><main>${body}</main>`, { status, headers: { "content-type": "text/html;charset=utf-8", ...extra } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, redirect_uri = url.origin + "/auth/callback";
    if (p === "/") return page(`<h1>Daily Shorts on autopilot</h1><p>Connect your YouTube channel once. Pick a niche and times. A new Short is made and posted for you every day.</p><p><a class=btn href="/auth/login">Connect YouTube channel</a></p><p style="opacity:.7">Permission asked: upload videos only. You can revoke it any time in your Google account.</p>`);
    if (p === "/auth/login") {
      const state = crypto.randomUUID();
      return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri, response_type: "code", scope: "openid email https://www.googleapis.com/auth/youtube.upload", access_type: "offline", prompt: "consent", state }), "set-cookie": `st=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` } });
    }
    if (p === "/auth/callback") {
      if (url.searchParams.get("state") !== (req.headers.get("cookie") || "").match(/st=([^;]+)/)?.[1]) return page("<p>Login expired. <a class=btn href=/auth/login>Try again</a></p>", 400);
      const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri, grant_type: "authorization_code" }) })).json();
      if (!tok.refresh_token || !tok.id_token) return page("<p>Google did not grant upload access. <a class=btn href=/auth/login>Try again</a></p>", 400);
      const claims = JSON.parse(dec.decode(unb64(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))));
      const id = claims.sub, old = JSON.parse((await env.DB.get("u:" + id)) || "{}");
      await env.DB.put("u:" + id, JSON.stringify({ email: claims.email, niche: old.niche || "quran", times: old.times || [0, 1, 2], active: true, status: "ok", rt: await seal(env, tok.refresh_token), connected: new Date().toISOString(), first_connected: old.first_connected || new Date().toISOString() }));
      return new Response(null, { status: 302, headers: { location: "/dashboard", "set-cookie": `sid=${encodeURIComponent(id + "|" + (await hmac(env, id)))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } });
    }
    if (p === "/auth/logout") return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "sid=; Max-Age=0; Path=/" } });
    if (p === "/dashboard" || p === "/api/settings") {
      const id = await sessionUser(env, req); if (!id) return new Response(null, { status: 302, headers: { location: "/" } });
      const u = JSON.parse((await env.DB.get("u:" + id)) || "null"); if (!u) return new Response(null, { status: 302, headers: { location: "/" } });
      if (p === "/api/settings" && req.method === "POST") {
        const f = await req.formData(), niche = f.get("niche");
        if (NICHES[niche]) u.niche = niche;
        u.times = SLOTS.map((_, i) => i).filter((i) => f.get("t" + i)); u.active = !!f.get("active");
        await env.DB.put("u:" + id, JSON.stringify(u)); return new Response(null, { status: 303, headers: { location: "/dashboard" } });
      }
      const log = JSON.parse((await env.DB.get("log:" + id)) || "[]");
      const expires = new Date(new Date(u.connected).getTime() + 7 * 864e5), daysLeft = Math.ceil((expires - Date.now()) / 864e5);
      const banner = u.status === "reconnect_required" ? `<div class=card style="background:#b3402a55"><b>Reconnect required.</b> Google ended the permission, so posting is paused (nothing fails silently). <a class=btn href=/auth/login>Reconnect channel</a></div>` : daysLeft <= 2 ? `<div class=card style="background:#d4af5a44">Pilot mode: Google ends this permission about ${esc(expires.toISOString().slice(0, 10))}. <a style=color:#d4af5a href=/auth/login>Reconnect now</a> to keep posting.</div>` : `<p style="opacity:.7">Connected ${esc(u.connected.slice(0, 10))}. Pilot mode: permission lasts 7 days, reconnect by ${esc(expires.toISOString().slice(0, 10))}.</p>`;
      return page(`<h1>Your channel</h1>${banner}<p>${esc(u.email)} <a href=/auth/logout style=color:#d4af5a>sign out</a></p><form method=post action=/api/settings class=card><p><label>Niche <select name=niche>${Object.entries(NICHES).map(([k, v]) => `<option value=${k} ${k === u.niche ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label></p><p>Post at (Cairo time):<br>${SLOTS.map((t, i) => `<label><input type=checkbox name=t${i} ${u.times.includes(i) ? "checked" : ""}> ${t}</label>`).join(" ")}</p><p><label><input type=checkbox name=active ${u.active ? "checked" : ""}> Posting on</label></p><button>Save</button></form><div class=card><b>Recent posts</b>${log.length ? log.slice(0, 15).map((l) => `<p>${esc(l.at.slice(0, 16))} ${l.ok ? `<a style=color:#d4af5a href="${esc(l.url)}">${esc(l.title)}</a>` : "failed: " + esc(l.err)}</p>`).join("") : "<p>Nothing posted yet.</p>"}</div>`);
    }
    if (p === "/api/due" || p === "/api/log") { // runner only
      if (req.headers.get("authorization") !== "Bearer " + env.RUNNER_TOKEN) return new Response("no", { status: 401 });
      if (p === "/api/due") {
        const slot = +url.searchParams.get("slot"), out = [];
        for (const k of (await env.DB.list({ prefix: "u:" })).keys) { const u = JSON.parse(await env.DB.get(k.name)); if (u.active && u.status !== "reconnect_required" && u.times.includes(slot)) out.push({ id: k.name.slice(2), niche: u.niche, refresh_token: await unseal(env, u.rt) }); }
        return Response.json(out);
      }
      const { id, ok, url: v, title, err, auth_lost } = await req.json(), lk = "log:" + id, log = JSON.parse((await env.DB.get(lk)) || "[]");
      if (auth_lost) { const uu = JSON.parse((await env.DB.get("u:" + id)) || "null"); if (uu) { uu.status = "reconnect_required"; await env.DB.put("u:" + id, JSON.stringify(uu)); } }
      log.unshift({ at: new Date().toISOString(), ok, url: v, title, err }); await env.DB.put(lk, JSON.stringify(log.slice(0, 50))); return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
