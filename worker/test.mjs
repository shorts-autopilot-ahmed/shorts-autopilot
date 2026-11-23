import w, { seal, unseal } from "./index.js";
const store = new Map(); const DB = { get: async k => store.get(k) ?? null, put: async (k, v) => store.set(k, v), list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) };
const env = { DB, SESSION_KEY: "k", RUNNER_TOKEN: "rt", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "s" };
const call = (p, o = {}) => w.fetch(new Request("https://x.dev" + p, o), env);
const eq = (a, b, m) => { if (a !== b) { console.log("FAIL", m, a, b); process.exit(1); } console.log("ok", m); };
eq((await call("/")).status, 200, "landing");
const l = await call("/auth/login"); eq(l.status, 302, "login redirect"); eq(l.headers.get("location").includes("youtube.upload"), true, "scope");
eq((await call("/dashboard")).status, 302, "dashboard needs login");
eq((await call("/api/due?slot=0")).status, 401, "runner auth");
eq(await unseal(env, await seal(env, "tok")), "tok", "encrypt roundtrip");
store.set("u:42", JSON.stringify({ connected: new Date().toISOString(), email: "a@b.c", niche: "quran", times: [0, 2], active: true, rt: await seal(env, "REFRESH") }));
const d = await (await call("/api/due?slot=2", { headers: { authorization: "Bearer rt" } })).json(); eq(d[0].refresh_token, "REFRESH", "due slot2");
eq((await (await call("/api/due?slot=1", { headers: { authorization: "Bearer rt" } })).json()).length, 0, "not due slot1");
await call("/api/log", { method: "POST", headers: { authorization: "Bearer rt" }, body: JSON.stringify({ id: "42", ok: true, url: "https://youtube.com/shorts/x", title: "T" }) });
// fake session cookie
const sig = (await (await import("node:crypto")).createHmac("sha256", "k").update("42").digest("base64"));
const dash = await call("/dashboard", { headers: { cookie: "sid=" + encodeURIComponent("42|" + sig) } });
const html = await dash.text(); eq(html.includes("a@b.c") && html.includes("shorts/x"), true, "dashboard renders user+history");
const fd = new FormData(); fd.set("niche", "motivation"); fd.set("t1", "on"); fd.set("active", "on");
await call("/api/settings", { method: "POST", headers: { cookie: "sid=" + encodeURIComponent("42|" + sig) }, body: fd });
eq(JSON.parse(store.get("u:42")).times.join(), "1", "settings saved"); eq(JSON.parse(store.get("u:42")).niche, "motivation", "niche saved");

await call("/api/log", { method: "POST", headers: { authorization: "Bearer rt" }, body: JSON.stringify({ id: "42", ok: false, err: "authorization expired", auth_lost: true }) });
eq(JSON.parse(store.get("u:42")).status, "reconnect_required", "auth loss flips status");
eq((await (await call("/api/due?slot=1", { headers: { authorization: "Bearer rt" } })).json()).length, 0, "paused channel not due");
const d2 = await (await call("/dashboard", { headers: { cookie: "sid=" + encodeURIComponent("42|" + sig) } })).text(); eq(d2.includes("Reconnect required"), true, "banner shown");
