#!/usr/bin/env python3
"""Daily runner: for each connected channel, render a Short and upload it public via YouTube Data API v3.
Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CHANNELS_JSON = [{"name":"..","refresh_token":".."}], SLOT (0,1,2)"""
import os, json, sys, hashlib, subprocess, urllib.request, urllib.parse, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
sys.path.insert(0, HERE)
import make_short

def post(url, data=None, headers=None, raw=None):
    req = urllib.request.Request(url, data=raw if raw is not None else urllib.parse.urlencode(data).encode(), headers={"User-Agent": "shorts-runner/1.0", **(headers or {})})
    return urllib.request.urlopen(req, timeout=300)

def access_token(rt):
    r = post("https://oauth2.googleapis.com/token", {"client_id": os.environ["GOOGLE_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_CLIENT_SECRET"], "refresh_token": rt, "grant_type": "refresh_token"})
    return json.load(r)["access_token"]

def upload(tok, path, meta):
    body = {"snippet": {"title": meta["title"], "description": meta["description"], "categoryId": "22"},
            "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False}}
    r = post("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
             raw=json.dumps(body).encode(), headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json; charset=UTF-8",
             "X-Upload-Content-Type": "video/mp4"})
    loc = r.headers["Location"]
    r = post(loc, raw=open(path, "rb").read(), headers={"Content-Type": "video/mp4"})
    return json.load(r)["id"]

if __name__ == "__main__":
    site = os.environ.get("SITE_URL"); H = {"Authorization": "Bearer " + os.environ.get("RUNNER_TOKEN", ""), "User-Agent": "shorts-runner/1.0"}
    if site:  # website mode: channels come from the Worker's KV
        channels = [dict(c, name=c["id"]) for c in json.load(open(os.environ.get("DUE_FILE", "due.json")))]
    else:
        channels = json.loads(os.environ["CHANNELS_JSON"])
    def log(ch, **kw):
        if site: post(f"{site}/api/log", raw=json.dumps(dict(kw, id=ch["id"])).encode(), headers=dict(H, **{"Content-Type": "application/json"}))
    failed = 0
    for ch in channels:   # each channel: {"name","refresh_token","niche"}
        try:
            salt = int(hashlib.sha1(ch["name"].encode()).hexdigest()[:6], 16); seq = int(ch.get("seq", 0)); a = make_short.pick(seq, niche=ch.get("niche", "quran"), salt=salt); meta = make_short.metadata(a)
            out = f"{HERE}/out/{ch['name']}.mp4"; make_short.render(a, out, seq, ch.get("sound", "drone"))
            try:
                tok = access_token(ch["refresh_token"])
            except urllib.error.HTTPError as e:
                if e.code in (400, 401):  # invalid_grant: authorization expired or revoked. Stop posting for this channel.
                    failed += 1; print(f"AUTH LOST {ch['name']}"); log(ch, ok=False, err="authorization expired", auth_lost=True); continue
                raise
            vid = upload(tok, out, meta)
            print(f"OK {ch['name']}: https://youtube.com/shorts/{vid}")
            log(ch, ok=True, url=f"https://youtube.com/shorts/{vid}", title=meta["title"])
        except urllib.error.HTTPError as e:
            failed += 1; print(f"FAIL {ch['name']}: HTTP {e.code}"); log(ch, ok=False, err=f"HTTP {e.code}")
        except Exception as e:
            failed += 1; print(f"FAIL {ch['name']}: {type(e).__name__}")
    sys.exit(1 if failed else 0)
