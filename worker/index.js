// Cloudflare Worker (free plan) + KV namespace "DB". Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_KEY, RUNNER_TOKEN
// Routes: / landing, /auth/login, /auth/callback, /dashboard, /api/settings, /api/due (runner only), /api/log (runner only), /auth/logout
const NICHES = { quran: "Quran & Adhkar", hikma: "Arabic Wisdom (حكمة اليوم)", motivation: "Daily Motivation", stoic: "Stoic Wisdom", facts: "Amazing Facts", health: "Healthy Habits", money: "Money Mindset" };
const ZONES = ["Africa/Cairo", "Asia/Riyadh", "Asia/Dubai", "Europe/London", "Europe/Paris", "Europe/Istanbul", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Karachi", "Asia/Kolkata", "Asia/Jakarta", "UTC"];
const MAX_TIMES = 6, LATE_MIN = 180; // posts per channel per day; a scheduled post still goes out up to 3h late (GitHub cron can lag)
function localNow(tz, d = new Date()) { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const get = async (env, k) => JSON.parse((await env.DB.get(k)) || "null"), put = (env, k, v) => env.DB.put(k, JSON.stringify(v));
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
    if (p === "/") return page(`<h1>Daily Shorts on autopilot</h1><p>Connect your YouTube channels. Pick a niche and your own posting times for each one. A fresh Short is made and posted for you automatically.</p><p><a class=btn href="/auth/login">Connect YouTube channel</a></p><p style="opacity:.7">Permission asked: upload videos only. You can revoke it any time in your Google account.</p>`);
    if (p === "/auth/login") {
      const state = crypto.randomUUID(), mode = url.searchParams.get("mode") || "login", ch = url.searchParams.get("ch") || "";
      return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri, response_type: "code", scope: "openid email https://www.googleapis.com/auth/youtube.upload", access_type: "offline", prompt: "consent select_account", state }), "set-cookie": `st=${state}|${mode}|${ch.replace(/[^a-z0-9]/g, "")}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` } });
    }
    if (p === "/auth/callback") {
      const [st, mode, chq] = decodeURIComponent((req.headers.get("cookie") || "").match(/st=([^;]+)/)?.[1] || "").split("|");
      if (!st || url.searchParams.get("state") !== st) return page("<p>Login expired. <a class=btn href=/auth/login>Try again</a></p>", 400);
      const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri, grant_type: "authorization_code" }) })).json();
      if (!tok.refresh_token || !tok.id_token) return page("<p>Google did not grant upload access. <a class=btn href=/auth/login>Try again</a></p>", 400);
      const claims = JSON.parse(dec.decode(unb64(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))));
      const sess = await sessionUser(env, req), owner = sess || claims.sub, now = new Date().toISOString();
      const o = (await get(env, "o:" + owner)) || { email: claims.email, channels: [] };
      const rt = await seal(env, tok.refresh_token);
      if (mode === "reconnect" && sess && o.channels.includes(chq)) {
        const c = await get(env, "ch:" + chq); if (c) { Object.assign(c, { rt, status: "ok", connected: now }); await put(env, "ch:" + chq, c); }
      } else if (sess ? mode === "add" : o.channels.length === 0) {
        const id = rid(); o.channels.push(id);
        await put(env, "ch:" + id, { id, owner, label: "Channel " + o.channels.length + " (" + claims.email + ")", niche: "quran", tz: "Africa/Cairo", times: ["14:00", "19:00"], active: true, status: "ok", rt, connected: now, first_connected: now, last_done: [], posted: 0 });
        await put(env, "o:" + owner, o);
      }
      return new Response(null, { status: 302, headers: { location: "/dashboard", "set-cookie": `sid=${encodeURIComponent(owner + "|" + (await hmac(env, owner)))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } });
    }
    if (p === "/auth/logout") return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "sid=; Max-Age=0; Path=/" } });
    if (p === "/dashboard" || p.startsWith("/api/settings") || p === "/api/delete") {
      const owner = await sessionUser(env, req); if (!owner) return new Response(null, { status: 302, headers: { location: "/" } });
      const o = await get(env, "o:" + owner); if (!o) return new Response(null, { status: 302, headers: { location: "/" } });
      if (req.method === "POST" && (p === "/api/settings" || p === "/api/delete")) {
        const f = await req.formData(), id = String(f.get("ch") || ""); if (!o.channels.includes(id)) return new Response("no", { status: 403 });
        if (p === "/api/delete") { await env.DB.delete("ch:" + id); await env.DB.delete("log:" + id); o.channels = o.channels.filter((x) => x !== id); await put(env, "o:" + owner, o); }
        else {
          const c = await get(env, "ch:" + id); if (!c) return new Response("gone", { status: 404 });
          if (NICHES[f.get("niche")]) c.niche = f.get("niche"); if (ZONES.includes(f.get("tz"))) c.tz = f.get("tz");
          c.label = String(f.get("label") || c.label).slice(0, 60);
          c.times = [...new Set(f.getAll("time").map((t) => String(t).trim()).filter((t) => toMin(t) !== null).map((t) => { const m = toMin(t); return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }))].sort().slice(0, MAX_TIMES);
          c.active = !!f.get("active"); await put(env, "ch:" + id, c);
        }
        return new Response(null, { status: 303, headers: { location: "/dashboard" } });
      }
      let cards = "";
      for (const id of o.channels) {
        const c = await get(env, "ch:" + id); if (!c) continue;
        const log = (await get(env, "log:" + id)) || [], expires = new Date(new Date(c.connected).getTime() + 7 * 864e5), daysLeft = Math.ceil((expires - Date.now()) / 864e5);
        const banner = c.status === "reconnect_required" ? `<div class=card style="background:#b3402a55"><b>Reconnect required.</b> Google ended the permission, so posting is paused (nothing fails silently). <a class=btn href="/auth/login?mode=reconnect&ch=${id}">Reconnect channel</a></div>` : daysLeft <= 2 ? `<div class=card style="background:#d4af5a44">Pilot mode: Google ends this permission about ${esc(expires.toISOString().slice(0, 10))}. <a style=color:#d4af5a href="/auth/login?mode=reconnect&ch=${id}">Reconnect now</a> to keep posting.</div>` : `<p style="opacity:.7">Connected ${esc(c.connected.slice(0, 10))}. Pilot mode: reconnect by ${esc(expires.toISOString().slice(0, 10))}.</p>`;
        const slots = [...c.times, ...Array(MAX_TIMES).fill("")].slice(0, MAX_TIMES);
        cards += `<div class=card>${banner}<form method=post action=/api/settings><input type=hidden name=ch value=${id}><p><label>Name <input name=label value="${esc(c.label)}"></label></p><p><label>Niche <select name=niche>${Object.entries(NICHES).map(([k, v]) => `<option value=${k} ${k === c.niche ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label></p><p><label>Time zone <select name=tz>${ZONES.map((z) => `<option ${z === c.tz ? "selected" : ""}>${z}</option>`).join("")}</select></label></p><p>Post at (any time you like, up to ${MAX_TIMES} per day, leave blank to skip):<br>${slots.map((t) => `<input type=time name=time value="${esc(t)}">`).join(" ")}</p><p><label><input type=checkbox name=active ${c.active ? "checked" : ""}> Posting on</label></p><button>Save</button></form><form method=post action=/api/delete onsubmit="return confirm('Remove this channel?')"><input type=hidden name=ch value=${id}><button style="background:#ffffff22;color:#fff8e1;margin-top:8px">Remove channel</button></form><b>Recent posts</b>${log.length ? log.slice(0, 8).map((l) => `<p>${esc(l.at.slice(0, 16))} ${l.ok ? `<a style=color:#d4af5a href="${esc(l.url)}">${esc(l.title)}</a>` : "failed: " + esc(l.err)}</p>`).join("") : "<p>Nothing posted yet.</p>"}</div>`;
      }
      return page(`<h1>Your channels</h1><p>${esc(o.email)} <a href=/auth/logout style=color:#d4af5a>sign out</a></p>${cards || "<p>No channels yet.</p>"}<p><a class=btn href="/auth/login?mode=add">+ Add another channel</a></p><p style="opacity:.7">Tip: to add a different channel, choose that channel's account on the Google screen.</p>`);
    }
    if (p === "/api/due" || p === "/api/log") { // runner only
      if (req.headers.get("authorization") !== "Bearer " + env.RUNNER_TOKEN) return new Response("no", { status: 401 });
      if (p === "/api/due") {
        const out = [];
        for (const k of (await env.DB.list({ prefix: "ch:" })).keys) {
          const c = JSON.parse(await env.DB.get(k.name)); if (!c.active || c.status === "reconnect_required") continue;
          const { date, min } = localNow(c.tz), done = c.last_done || [];
          const t = c.times.find((t) => { const m = toMin(t); return m !== null && min >= m && min - m <= LATE_MIN && !done.includes(date + " " + t); });
          if (!t) continue;
          c.last_done = [...done, date + " " + t].slice(-24); const seq = c.posted || 0; c.posted = seq + 1; await put(env, k.name, c);
          out.push({ id: c.id, niche: c.niche, seq, refresh_token: await unseal(env, c.rt) });
        }
        return Response.json(out);
      }
      const { id, ok, url: v, title, err, auth_lost } = await req.json(), lk = "log:" + id, log = (await get(env, lk)) || [];
      if (auth_lost) { const cc = await get(env, "ch:" + id); if (cc) { cc.status = "reconnect_required"; await put(env, "ch:" + id, cc); } }
      log.unshift({ at: new Date().toISOString(), ok, url: v, title, err }); await put(env, lk, log.slice(0, 50)); return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
