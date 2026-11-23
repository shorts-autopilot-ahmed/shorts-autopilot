#!/usr/bin/env python3
"""Run once per channel owner: prints a consent URL, takes the code, prints the refresh token to add to CHANNELS_JSON.
Uses the loopback flow: owner approves, copies the 'code' value from the redirected URL."""
import os, json, urllib.parse, urllib.request
cid, sec = os.environ["GOOGLE_CLIENT_ID"], os.environ["GOOGLE_CLIENT_SECRET"]
redir = "http://localhost:8080/"
print("Open:", "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({"client_id": cid, "redirect_uri": redir,
  "response_type": "code", "scope": "https://www.googleapis.com/auth/youtube.upload", "access_type": "offline", "prompt": "consent"}))
code = input("Paste the code= value from the address bar: ").strip()
r = urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", urllib.parse.urlencode({"code": code, "client_id": cid,
  "client_secret": sec, "redirect_uri": redir, "grant_type": "authorization_code"}).encode()))
print(json.dumps({"name": input("Channel label: "), "refresh_token": json.load(r)["refresh_token"]}))
