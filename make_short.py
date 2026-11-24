#!/usr/bin/env python3
"""Generic niche Short renderer. Niche packs live in niches/*.json. Render one ~25s vertical Quran Short: Amiri ayah over animated gradient + synthesized ambient pad."""
import sys, json, subprocess, os, hashlib, datetime
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
W, H, DUR = 1080, 1920, 25
PALETTES = [("0x0b3d3a","0x1b2a6b"),("0x123b2e","0x0e2a4d"),("0x2a1b5c","0x0b3d4a"),("0x0d3b4f","0x3a1f5e")]

def load(niche):
    return json.load(open(f"{HERE}/niches/{niche}.json"))

def pick(seq=0, niche="quran", salt=0):
    """seq: how many posts this channel has had; salt: per-channel offset so channels differ."""
    n = load(niche)
    a = dict(n["items"][(salt + seq) % len(n["items"])]); a["_n"] = n
    return a

def text_png(a, path):
    img = Image.new("RGBA", (W, H), (0,0,0,0)); d = ImageDraw.Draw(img)
    n = a["_n"]; rtl = n["rtl"]; kw = dict(direction="rtl") if rtl else {}
    font = ImageFont.truetype(f"{HERE}/fonts/{n['font']}", n["size"])
    small = ImageFont.truetype(f"{HERE}/fonts/Amiri-Regular.ttf", 48)
    lines, cur = [], ""
    for w in a["text"].split(" "):
        t = (cur+" "+w).strip()
        if d.textlength(t, font=font, **kw) > W-200 and cur:
            lines.append(cur); cur = w
        else: cur = t
    lines.append(cur)
    y = H//2 - len(lines)*80 - 40
    for l in lines:
        d.text((W/2, y), l, font=font, fill=(255,248,225,255), anchor="ma", **kw)
        y += 160
    d.line([(W/2-120, y+20),(W/2+120, y+20)], fill=(212,175,90,255), width=3)
    d.text((W/2, y+60), a["sub"], font=small, fill=(212,175,90,255), anchor="ma", **kw)
    img.save(path)

NICHE_SOUND = {"quran": "bells", "hikma": "rain", "stoic": "drone", "motivation": "uplift", "money": "uplift", "facts": "bells", "health": "waves"}
def render(a, out, palette=0, sound="auto"):
    if sound not in ("drone","rain","waves","bells","uplift","none"): sound = NICHE_SOUND.get(a["_n"].get("id") or "", "bells")
    P = a["_n"]["palettes"]; c0, c1 = P[palette % len(P)]
    png = out + ".text.png"; text_png(a, png)
    # slow drifting gradient (gradients source with speed) + text fade in/out + 3-note drone pad
    aud = ("aevalsrc='0.10*sin(2*PI*110*t)+0.07*sin(2*PI*164.81*t)+0.05*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.15*t))':s=44100:d=%d,"
           "lowpass=f=900,afade=t=in:d=3,afade=t=out:st=%d:d=4,aecho=0.8:0.7:600:0.4,volume=0.8") % (DUR, DUR-4)
    fc = (f"gradients=s={W}x{H}:c0={c0}:c1={c1}:x0=0:y0=0:x1={W}:y1={H}:speed=0.015:d={DUR}:r=30[bg];"
          f"[1:v]format=rgba,fade=t=in:st=1:d=2:alpha=1,fade=t=out:st={DUR-3}:d=2.5:alpha=1[tx];"
          f"[bg][tx]overlay=0:0,format=yuv420p[v]")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-filter_complex",fc.replace("[1:v]","[1:v]"),
        "-f","lavfi","-i","anullsrc=r=44100",  # placeholder removed below
        ], check=False) if False else None
    bells = ("aevalsrc='0.16*sin(2*PI*523.25*t)*exp(-1.6*mod(t,3.2))+0.13*sin(2*PI*659.25*t)*exp(-1.6*mod(t+1.1,3.2))+0.11*sin(2*PI*783.99*t)*exp(-1.6*mod(t+2.1,3.2))+0.05*sin(2*PI*261.63*t)':s=44100:d=%d,aecho=0.8:0.8:700|1100:0.4|0.3,lowpass=f=3500" % DUR)
    SND = {
        "drone": ("aevalsrc='0.10*sin(2*PI*110*t)+0.07*sin(2*PI*164.81*t)+0.05*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.15*t))':s=44100:d=%d,lowpass=f=900,aecho=0.8:0.7:600:0.4" % DUR),
        "rain": "anoisesrc=color=pink:r=44100:a=0.5:d=%d,highpass=f=500,lowpass=f=7000,volume=1.0" % DUR,
        "waves": "anoisesrc=color=brown:r=44100:a=0.8:d=%d,lowpass=f=1000,tremolo=f=0.12:d=0.7,volume=1.2" % DUR,
        "bells": bells,
        "uplift": ("aevalsrc='0.10*sin(2*PI*261.63*t)+0.07*sin(2*PI*329.63*t)+0.06*sin(2*PI*392*t)+0.14*(sin(2*PI*523.25*t)*exp(-5*mod(t,2))+sin(2*PI*659.25*t)*exp(-5*mod(t+1.5,2))+sin(2*PI*783.99*t)*exp(-5*mod(t+1,2))+sin(2*PI*1046.5*t)*exp(-5*mod(t+0.5,2)))':s=44100:d=%d,aecho=0.8:0.6:400:0.3,lowpass=f=4000" % DUR),
        "none": "anullsrc=r=44100:cl=stereo",
    }
    snd = SND.get(sound, SND["drone"])
    fc2 = (f"gradients=s={W}x{H}:c0={c0}:c1={c1}:x0=0:y0=0:x1={W}:y1={H}:speed=0.015:d={DUR}:r=30[bg];"
           f"[0:v]format=rgba,fade=t=in:st=1:d=2:alpha=1,fade=t=out:st={DUR-3}:d=2.5:alpha=1[tx];"
           f"[bg][tx]overlay=0:0,format=yuv420p[v];"
           f"{snd},atrim=0:{DUR},afade=t=in:d=3,afade=t=out:st={DUR-4}:d=4[a]")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-loop","1","-framerate","30","-t",str(DUR),"-i",png,
        "-filter_complex",fc2,"-map","[v]","-map","[a]","-c:v","libx264","-preset","veryfast","-crf","22",
        "-c:a","aac","-b:a","128k","-t",str(DUR),"-movflags","+faststart",out], check=True)
    os.remove(png)

def metadata(a):
    n = a["_n"]; f = dict(a, hashtags=n["hashtags"])
    return {"title": n["title"].format(**f), "description": n["desc"].format(**f).strip()}

if __name__ == "__main__":
    seq = int(sys.argv[1]) if len(sys.argv)>1 else 0
    out = sys.argv[2] if len(sys.argv)>2 else f"{HERE}/out/short.mp4"
    niche = sys.argv[3] if len(sys.argv)>3 else "quran"
    a = pick(seq, niche=niche); render(a, out, seq, sys.argv[4] if len(sys.argv)>4 else "auto"); print(json.dumps(metadata(a), ensure_ascii=False))
