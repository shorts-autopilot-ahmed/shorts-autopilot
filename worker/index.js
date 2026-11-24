// Cloudflare Worker (free plan) + KV namespace "DB". Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_KEY, RUNNER_TOKEN
// Routes: / landing, /auth/login, /auth/callback, /dashboard, /api/settings, /api/due (runner only), /api/log (runner only), /auth/logout
const NICHES = { quran: "Quran & Adhkar", hikma: "Arabic Wisdom (حكمة اليوم)", motivation: "Daily Motivation", stoic: "Stoic Wisdom", facts: "Amazing Facts", health: "Healthy Habits", money: "Money Mindset" };
const ZONES = ["Africa/Cairo", "Asia/Riyadh", "Asia/Dubai", "Europe/London", "Europe/Paris", "Europe/Istanbul", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Karachi", "Asia/Kolkata", "Asia/Jakarta", "UTC"];
const MAX_TIMES = 6, LATE_MIN = 180; // posts per channel per day; a scheduled post still goes out up to 3h late (GitHub cron can lag)
function localNow(tz, d = new Date()) { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
function parseTarget(t) { t = decodeURIComponent(String(t || "")).trim(); const m = /(UC[\w-]{22})/.exec(t) || /@([\w.\-]{3,30})/.exec(t) || /youtube\.com\/(?:c|user)\/([\w.\-]+)/i.exec(t) || (/^[\w.\-]{3,30}$/.test(t) ? [0, t] : null); return m ? m[1].toLowerCase() : ""; }
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
const page = (body, status = 200, extra = {}) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Auto Shorts</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#f6f8fb;color:#1f2933;min-height:100vh;display:grid;place-items:center}main{max-width:560px;padding:28px;width:100%}.card{background:#fff;border:1px solid #e3e8ef;box-shadow:0 1px 3px #0001;border-radius:14px;padding:18px;margin:14px 0}input,select{border:1px solid #cbd5e1!important;background:#fff;color:#1f2933;border-radius:8px;padding:8px}.btn,button{background:#16a34a;color:#fff;border:0;padding:12px 22px;border-radius:10px;font-weight:700;text-decoration:none;display:inline-block;cursor:pointer}select,label{font-size:1rem}</style><main>${body}</main>`, { status, headers: { "content-type": "text/html;charset=utf-8", ...extra } });

const inner = {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, redirect_uri = url.origin + "/auth/callback";
    if (p === "/") return page(`<h1>Daily Shorts on autopilot</h1><p>Connect your YouTube channels. Pick a niche and your own posting times for each one. A fresh Short is made and posted for you automatically.</p><form action=/auth/login class=card><input type=hidden name=mode value=login><p><label>Your channel link or @handle<br><input name=target placeholder="https://youtube.com/@yourchannel" style="width:100%;padding:10px;border-radius:8px;border:0;margin-top:6px"></label></p><button>Connect YouTube channel</button><p style="color:#64748b;font-size:.9rem">We check that the Google account you pick really owns that channel.</p></form><p style="color:#64748b">Permission asked: upload videos only. You can revoke it any time in your Google account.</p>`);
    if (p === "/auth/login") {
      const state = crypto.randomUUID(), mode = url.searchParams.get("mode") || "login", ch = url.searchParams.get("ch") || "", target = parseTarget(url.searchParams.get("target"));
      return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri, response_type: "code", scope: "openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly", access_type: "offline", prompt: "consent select_account", state }), "set-cookie": `st=${state}|${mode}|${ch.replace(/[^a-z0-9]/g, "")}|${encodeURIComponent(target)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` } });
    }
    if (p === "/auth/callback") {
      const [st, mode, chq, tq] = decodeURIComponent((req.headers.get("cookie") || "").match(/st=([^;]+)/)?.[1] || "").split("|"), want = decodeURIComponent(tq || "");
      if (!st || url.searchParams.get("state") !== st) return page("<p>Login expired. <a class=btn href=/auth/login>Try again</a></p>", 400);
      const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri, grant_type: "authorization_code" }) })).json();
      if (!tok.refresh_token || !tok.id_token) return page("<p>Google did not grant upload access. <a class=btn href=/auth/login>Try again</a></p>", 400);
      const yt = await (await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: "Bearer " + tok.access_token } })).json(), yc = yt.items?.[0];
      if (!yc) return page("<p>That Google account has no YouTube channel (or channel access was not granted). <a class=btn href=/auth/login>Try again</a></p>", 400);
      const handle = (yc.snippet.customUrl || "").replace(/^@/, "").toLowerCase(), cname = yc.snippet.title;
      if (want && want !== yc.id.toLowerCase() && want !== handle) return page(`<p>You pasted <b>${esc(want)}</b>, but the Google account you picked owns <b>${esc(cname)}</b>${handle ? " (@" + esc(handle) + ")" : ""}. Nothing was connected. <a class=btn href="/auth/login?mode=${esc(mode)}&ch=${esc(chq || "")}">Try again</a></p>`, 400);
      const claims = JSON.parse(dec.decode(unb64(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))));
      const sess = await sessionUser(env, req), owner = sess || claims.sub, now = new Date().toISOString();
      const o = (await get(env, "o:" + owner)) || { email: claims.email, channels: [] };
      let existing = null; for (const x of o.channels) { const c = await get(env, "ch:" + x); if (c && c.yt === yc.id) existing = c; }
      const rt = await seal(env, tok.refresh_token);
      if (existing) { Object.assign(existing, { rt, status: "ok", connected: now }); await put(env, "ch:" + existing.id, existing); }
      else if (mode === "reconnect" && sess && o.channels.includes(chq)) {
        const c = await get(env, "ch:" + chq); if (c) { Object.assign(c, { rt, status: "ok", connected: now }); await put(env, "ch:" + chq, c); }
      } else if (sess ? mode === "add" : o.channels.length === 0) {
        const id = rid(); o.channels.push(id);
        await put(env, "ch:" + id, { id, owner, yt: yc.id, handle, label: cname, niche: "quran", tz: "Africa/Cairo", times: ["14:00", "19:00"], active: true, status: "ok", rt, connected: now, first_connected: now, last_done: [], posted: 0 });
        await put(env, "o:" + owner, o);
      }
      return new Response(null, { status: 302, headers: { location: "/dashboard", "set-cookie": `sid=${encodeURIComponent(owner + "|" + (await hmac(env, owner)))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000` } });
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
        const banner = c.status === "reconnect_required" ? `<div class=card style="background:#fee2e2"><b>Reconnect required.</b> Google ended the permission, so posting is paused (nothing fails silently). <a class=btn href="/auth/login?mode=reconnect&ch=${id}">Reconnect channel</a></div>` : daysLeft <= 2 ? `<div class=card style="background:#fef3c7">Pilot mode: Google ends this permission about ${esc(expires.toISOString().slice(0, 10))}. <a style=color:#15803d href="/auth/login?mode=reconnect&ch=${id}">Reconnect now</a> to keep posting.</div>` : `<p style="color:#64748b">Connected ${esc(c.connected.slice(0, 10))}. Pilot mode: reconnect by ${esc(expires.toISOString().slice(0, 10))}.</p>`;
        const slots = [...c.times, ...Array(MAX_TIMES).fill("")].slice(0, MAX_TIMES);
        cards += `<div class=card>${banner}<form method=post action=/api/settings><input type=hidden name=ch value=${id}><p>${c.handle ? "@" + esc(c.handle) : ""}</p><p><label>Name <input name=label value="${esc(c.label)}"></label></p><p><label>Niche <select name=niche>${Object.entries(NICHES).map(([k, v]) => `<option value=${k} ${k === c.niche ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label></p><p><label>Time zone <select name=tz>${ZONES.map((z) => `<option ${z === c.tz ? "selected" : ""}>${z}</option>`).join("")}</select></label></p><p>Post at (any time you like, up to ${MAX_TIMES} per day, leave blank to skip):<br>${slots.map((t) => `<input type=time name=time value="${esc(t)}">`).join(" ")}</p><p><label><input type=checkbox name=active ${c.active ? "checked" : ""}> Posting on</label></p><button>Save</button></form><form method=post action=/api/delete onsubmit="return confirm('Remove this channel?')"><input type=hidden name=ch value=${id}><button style="background:#e5e7eb;color:#1f2933;margin-top:8px">Remove channel</button></form><b>Recent posts</b>${log.length ? log.slice(0, 8).map((l) => `<p>${esc(l.at.slice(0, 16))} ${l.ok ? `<a style=color:#15803d href="${esc(l.url)}">${esc(l.title)}</a>` : "failed: " + esc(l.err)}</p>`).join("") : "<p>Nothing posted yet.</p>"}</div>`;
      }
      return page(`<h1>Your channels</h1><p>${esc(o.email)} <a href=/auth/logout style=color:#15803d>sign out</a></p>${cards || "<p>No channels yet.</p>"}<form action=/auth/login class=card><input type=hidden name=mode value=add><p><label>Add another channel: paste its link or @handle<br><input name=target placeholder="https://youtube.com/@otherchannel" style="width:100%;padding:10px;border-radius:8px;border:0;margin-top:6px"></label></p><button>+ Add channel</button><p style="color:#64748b;font-size:.9rem">On the Google screen choose the account that owns that channel.</p></form>`);
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


const pw = async (pass, salt) => b64(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: 100000 }, await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]), 256)));
const okUser = (u) => /^[a-z0-9_.]{3,30}$/.test(u), okPass = (p) => p.length >= 8 && p.length <= 200;
const sidCookie = async (env, owner) => `sid=${encodeURIComponent(owner + "|" + (await hmac(env, owner)))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000`;
const newCred = async (pass) => { const salt = b64(crypto.getRandomValues(new Uint8Array(16))); return { salt, hash: await pw(pass, salt) }; };
const eqs = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const ACC_FORMS = `<div class=card><h2 style="margin-top:0">Sign in with username</h2><form method=post action=/signin><p><input name=username placeholder="Username" required autocomplete=username style="width:100%"></p><p><input name=password type=password placeholder="Password" required autocomplete=current-password style="width:100%"></p><button>Sign in</button></form><hr style="border:0;border-top:1px solid #e3e8ef;margin:16px 0"><h2 style="margin-top:0">Create an account</h2><form method=post action=/register><p><input name=username placeholder="Choose a username (letters, numbers, . _)" required autocomplete=username style="width:100%"></p><p><input name=password type=password placeholder="Password (8 characters or more)" required minlength=8 autocomplete=new-password style="width:100%"></p><button>Create account</button></form></div><p style="text-align:center;color:#64748b">Or connect with Google below.</p>`;
const ACC_SET = `<div class=card><b>Set a username and password</b><p style="color:#64748b">So you can sign in without Google next time.</p><form method=post action=/api/account><p><input name=username placeholder="Username" required style="width:100%"></p><p><input name=password type=password placeholder="Password (8 characters or more)" required minlength=8 style="width:100%"></p><button>Save</button></form></div>`;
const bad = (m) => page(`<p>${m} <a class=btn href=/>Back</a></p>`, 400);
async function acct(req, env, p, sess) {
  if (req.method !== "POST") return null;
  const f = await req.formData(), user = String(f.get("username") || "").trim().toLowerCase(), pass = String(f.get("password") || "");
  if (p === "/api/account") {
    if (!sess) return new Response(null, { status: 302, headers: { location: "/" } });
    const o = await get(env, "o:" + sess); if (!o || o.username) return bad("Account already has a username.");
    if (!okUser(user) || !okPass(pass)) return bad("Username must be 3 to 30 letters, numbers, dots or underscores, and the password at least 8 characters.");
    if (await get(env, "a:" + user)) return bad("That username is taken.");
    await put(env, "a:" + user, { owner: sess, ...(await newCred(pass)) }); o.username = user; await put(env, "o:" + sess, o);
    return new Response(null, { status: 303, headers: { location: "/dashboard" } });
  }
  if (p === "/register") {
    if (!okUser(user) || !okPass(pass)) return bad("Username must be 3 to 30 letters, numbers, dots or underscores, and the password at least 8 characters.");
    if (await get(env, "a:" + user)) return bad("That username is taken.");
    const owner = "u" + rid(); await put(env, "a:" + user, { owner, ...(await newCred(pass)) }); await put(env, "o:" + owner, { email: user, username: user, channels: [] });
    return new Response(null, { status: 303, headers: { location: "/dashboard", "set-cookie": await sidCookie(env, owner) } });
  }
  if (p === "/signin") {
    const a = okUser(user) ? await get(env, "a:" + user) : null, tk = "f:" + user, fl = (await get(env, tk)) || { n: 0, t: 0 };
    if (fl.n >= 5 && Date.now() - fl.t < 900000) return bad("Too many wrong attempts. Wait 15 minutes.");
    if (!a || !eqs(await pw(pass, a.salt), a.hash)) { if (okUser(user)) await put(env, tk, { n: (Date.now() - fl.t < 900000 ? fl.n : 0) + 1, t: Date.now() }); return bad("Wrong username or password."); }
    return new Response(null, { status: 303, headers: { location: "/dashboard", "set-cookie": await sidCookie(env, a.owner) } });
  }
  return null;
}
const AR = [
["Daily Shorts on autopilot","شورتس يومية على الطيار الآلي"],
["Connect your YouTube channels. Pick a niche and your own posting times for each one. A fresh Short is made and posted for you automatically.","اربط قنوات يوتيوب بتاعتك. اختار المجال ومواعيد النشر لكل قناة. بنعمل شورت جديد وننشره لك أوتوماتيك."],
["Your channel link or @handle","رابط قناتك أو @اسم القناة"],
["Connect YouTube channel","اربط قناة يوتيوب"],
["We check that the Google account you pick really owns that channel.","بنتأكد إن حساب جوجل اللي هتختاره هو فعلاً صاحب القناة."],
["Permission asked: upload videos only. You can revoke it any time in your Google account.","الصلاحية المطلوبة: رفع الفيديوهات فقط. تقدر تلغيها في أي وقت من حساب جوجل."],
["Login expired.","انتهت جلسة الدخول."],["Try again","حاول تاني"],
["Google did not grant upload access.","جوجل ما أعطتش صلاحية الرفع."],
["That Google account has no YouTube channel (or channel access was not granted).","حساب جوجل ده مالوش قناة يوتيوب (أو ما اتعطتش صلاحية القناة)."],
["You pasted","انت لصقت"],[", but the Google account you picked owns ","، لكن حساب جوجل اللي اخترته بيملك "],["Nothing was connected.","ما اتربطش أي شيء."],
["Sign in with username","الدخول باسم المستخدم"],["Create an account","إنشاء حساب"],["Create account","إنشاء حساب"],["Sign in","دخول"],["Username (letters, numbers, . _)","اسم المستخدم"],["Choose a username (letters, numbers, . _)","اختر اسم مستخدم (حروف وأرقام . _)"],["Password (8 characters or more)","كلمة السر (٨ أحرف أو أكثر)"],["Username: ","اسم المستخدم: "],["Username","اسم المستخدم"],["Password","كلمة السر"],["Or connect with Google below.","أو اربط عن طريق جوجل بالأسفل."],["Set a username and password","حدد اسم مستخدم وكلمة سر"],["So you can sign in without Google next time.","عشان تدخل من غير جوجل المرة الجاية."],["Wrong username or password.","اسم المستخدم أو كلمة السر غلط."],["That username is taken.","اسم المستخدم ده مستخدم."],["Too many wrong attempts. Wait 15 minutes.","محاولات خاطئة كتير. استنى ١٥ دقيقة."],["Back","رجوع"],["Username must be 3 to 30 letters, numbers, dots or underscores, and the password at least 8 characters.","اسم المستخدم ٣ إلى ٣٠ حرف أو رقم أو . _ وكلمة السر ٨ أحرف على الأقل."],["Account already has a username.","الحساب ليه اسم مستخدم بالفعل."],
["Your channels","قنواتك"],["sign out","تسجيل خروج"],["No channels yet.","لا توجد قنوات بعد."],
["Add another channel: paste its link or @handle","أضف قناة تانية: الصق رابطها أو @اسمها"],["+ Add channel","+ إضافة قناة"],
["On the Google screen choose the account that owns that channel.","في شاشة جوجل اختار الحساب اللي بيملك القناة دي."],
["Reconnect required.","لازم إعادة الربط."],["Google ended the permission, so posting is paused (nothing fails silently).","جوجل أنهت الصلاحية فالنشر متوقف (مفيش حاجة بتفشل في الخفاء)."],
["Reconnect channel","إعادة ربط القناة"],["Reconnect now","أعد الربط الآن"],["to keep posting.","عشان النشر يكمل."],
["Pilot mode: Google ends this permission about ","وضع التجربة: جوجل بتنهي الصلاحية حوالي "],["Pilot mode: reconnect by ","وضع التجربة: أعد الربط قبل "],["Connected ","تم الربط "],
["Name ","الاسم "],["Niche ","المجال "],["Time zone ","المنطقة الزمنية "],
["Post at (any time you like, up to ","وقت النشر (أي وقت تحبه، حتى "],[" per day, leave blank to skip):"," في اليوم، اتركه فاضي للتخطي):"],
["Posting on","النشر شغال"],["Save","حفظ"],["Remove channel","حذف القناة"],["Remove this channel?","حذف القناة دي؟"],
["Recent posts","آخر المنشورات"],["Nothing posted yet.","لم يتم النشر بعد."],["failed: ","فشل: "],
["Quran & Adhkar","القرآن والأذكار"],["Daily Motivation","تحفيز يومي"],["Stoic Wisdom","حكمة الرواقيين"],["Amazing Facts","حقائق مذهلة"],["Healthy Habits","عادات صحية"],["Money Mindset","عقلية المال"],
["https://youtube.com/@yourchannel","https://youtube.com/@قناتك"],
];
AR.sort((a, b) => b[0].length - a[0].length);
const DARK = "body{background:#0f172a!important;color:#e2e8f0!important}.card{background:#1e293b!important;border-color:#334155!important}input,select{background:#0f172a!important;color:#e2e8f0!important;border-color:#475569!important}footer a{color:#cbd5e1!important}";
export default {
  async fetch(req, env) {
    const u = new URL(req.url), ck = req.headers.get("cookie") || "";
    if (u.pathname === "/set") {
      let back = u.searchParams.get("back") || "/"; if (!/^\/[^\/\\]*$/.test(back)) back = "/";
      const h = new Headers({ location: back }), o = "; Path=/; Max-Age=31536000; Secure; SameSite=Lax";
      const l = u.searchParams.get("lang"), t = u.searchParams.get("theme");
      if (l === "ar" || l === "en") h.append("set-cookie", "lang=" + l + o);
      if (t === "dark" || t === "light") h.append("set-cookie", "theme=" + t + o);
      return new Response(null, { status: 302, headers: h });
    }
    const sidOk = await sessionUser(env, req);
    if (["/register", "/signin", "/api/account"].includes(u.pathname)) { const ar0 = await acct(req, env, u.pathname, sidOk); if (ar0) return ar0; }
    if (sidOk && u.pathname === "/") return new Response(null, { status: 302, headers: { location: "/dashboard" } });
    const r = await inner.fetch(req, env);
    if (!(r.headers.get("content-type") || "").includes("text/html")) return r;
    const ar = /(?:^|;\s*)lang=ar/.test(ck), dark = /(?:^|;\s*)theme=dark/.test(ck);
    let html = await r.text();
    if (u.pathname === "/" ) html = html.replace("<form action=/auth/login class=card>", ACC_FORMS + "<form action=/auth/login class=card>");
    if (u.pathname === "/dashboard" && sidOk) { const oo = await get(env, "o:" + sidOk); html = html.replace("<form action=/auth/login class=card><input type=hidden name=mode value=add>", (oo && oo.username ? `<p style="color:#64748b">Username: <b>${esc(oo.username)}</b></p>` : ACC_SET) + "<form action=/auth/login class=card><input type=hidden name=mode value=add>"); }
    if (ar) { for (const [a, b] of AR) html = html.split(a).join(b); html = html.replace("<!doctype html>", "<!doctype html><html lang=ar dir=rtl>").replace("<title>Auto Shorts</title>", "<title>شورتس أوتوماتيك</title>"); }
    if (dark) html = html.replace("</style>", DARK + "</style>");
    const back = encodeURIComponent(u.pathname);
    const foot = `<footer style="text-align:center;margin:0 0 12px;font-size:.9rem;color:#64748b"><a style=color:#64748b href="/set?lang=${ar ? "en" : "ar"}&back=${back}">${ar ? "English" : "العربية"}</a> &middot; <a style=color:#64748b href="/set?theme=${dark ? "light" : "dark"}&back=${back}">${ar ? (dark ? "فاتح" : "داكن") : (dark ? "Light" : "Dark")}</a></footer>`;
    html = html.replace("<main>", "<main>" + foot);
    const h = new Headers(r.headers); h.delete("content-length");
    const sm = ck.match(/sid=([^;]+)/); if (sidOk && sm && !h.has("set-cookie")) h.append("set-cookie", `sid=${sm[1]}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000`);
    return new Response(html, { status: r.status, headers: h });
  },
};
