#!/usr/bin/env python3
"""Train-a-Bot Arcade smoke test.
Builds the offline snapshot, asserts it is self-contained, checks the server's
/healthz on a spare port, then runs a headless Chrome playthrough (tests/play.mjs via
CDP): play, crash, train 3,000 episodes, verify learning, watch, compare, ghost, mute, help, reload.
Usage: python3 tests/smoke_test.py   (or ./run.sh test)
"""
import json, os, re, socket, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(HERE, "dist", "train-bot-arcade.html")
RES = []


def check(ok, msg, info=""):
    RES.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + msg + (f"  [{info}]" if info else ""), flush=True)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def main():
    print(f"Train-a-Bot Arcade smoke · {time.strftime('%Y-%m-%d %H:%M %Z')}", flush=True)
    subprocess.run([sys.executable, os.path.join(HERE, "build.py")], check=True, capture_output=True)
    html = open(DIST, encoding="utf-8").read()
    size = os.path.getsize(DIST)
    check(size > 50000, f"offline snapshot built ({size:,} bytes)")
    check(open(os.path.join(HERE, "dist", "index.html"), encoding="utf-8").read() == html, "dist/index.html identical copy")
    check("<style>" in html and html.count("<script>") >= 2, "CSS + core.js + app.js inlined")
    bad = re.findall(r'<(?:script|link|img|iframe|source)[^>]+(?:src|href)\s*=\s*["\'](?!data:)[^"\']+', html, re.I)
    check(not bad, "no external script/link/img tags", str(bad[:3]))
    urls = [u for u in re.findall(r"https?://[^\s\"'<>)]+", html) if "w3.org/2000/svg" not in u]
    check(not urls, "no external http(s) URLs", str(urls[:3]))
    check("fonts.googleapis" not in html and "cdn." not in html.lower() and "unpkg" not in html, "no CDN hosts")
    check("__TBA__" in html and "TBA_CORE" in html, "test API + core embedded")
    check("Q-learning" in html and "trainEpisode" in html, "real Q-learning trainer embedded")

    # node-side core sanity (pure JS engine shared with browser)
    r = subprocess.run(["node", "-e", """
const C=require(process.argv[1]); const a=new C.Agent({seed:7}); for(let i=0;i<1500;i++) a.trainEpisode('easy');
const s=C.TRACKS.map(t=>a.evaluate(t.seed,'easy').score); const z=new C.Agent({seed:7});
const u=C.TRACKS.map(t=>z.evaluate(t.seed,'easy').score);
console.log(JSON.stringify({trained:s,untrained:u}));""", os.path.join(HERE, "web", "core.js")], capture_output=True, text=True, timeout=60)
    try:
        j = json.loads(r.stdout.strip().splitlines()[-1])
        ta, ua = sum(j["trained"]) / 5, sum(j["untrained"]) / 5
        check(ta > ua * 3, "node: 1,500 easy episodes beats untrained bot by >3x", f"{ua:.0f} -> {ta:.0f}")
    except Exception as e:
        check(False, "node core sanity", (r.stdout + r.stderr)[-300:])

    # server health on a spare port
    port = free_port()
    env = dict(os.environ, TBA_PORT=str(port))
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok = False
        for _ in range(40):
            time.sleep(0.1)
            try:
                hj = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1).read())
                ok = hj.get("ok") is True; break
            except Exception:
                pass
        check(ok, f"server /healthz ok (TBA_PORT={port})")
        page = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read().decode()
        check("Train-a-Bot Arcade" in page, "server serves the game at /")
    finally:
        srv.terminate()

    print("headless Chrome playthrough (tests/play.mjs) ...", flush=True)
    t0 = time.time()
    r = subprocess.run(["node", "--experimental-websocket", os.path.join(HERE, "tests", "play.mjs")],
                       capture_output=True, text=True, timeout=240, cwd=HERE)
    out = None
    for line in reversed(r.stdout.strip().splitlines()):
        if line.strip().startswith("{"):
            try: out = json.loads(line); break
            except Exception: pass
    if not out:
        check(False, "play.mjs produced JSON", (r.stdout + r.stderr)[-800:])
    else:
        for c in out.get("checks", []):
            check(c.get("ok"), "browser: " + c.get("msg", "?"), c.get("info", "")[:200])
        check(out.get("failed", 1) == 0, f"playthrough summary {out.get('passed')}/{out.get('passed', 0) + out.get('failed', 0)}")
    print(f"     play took {time.time() - t0:.1f}s", flush=True)

    shots = os.path.join(HERE, "screenshots")
    if os.path.isdir(shots):
        pngs = [f for f in os.listdir(shots) if f.endswith(".png")]
        best = [f for f in pngs if f.startswith("00-best")]
        if pngs:
            check(bool(best), f"hero screenshot 00-best-*.png ({len(pngs)} shots)", ",".join(best) or "none")

    n, p = len(RES), sum(RES)
    print(f"RESULT: {p}/{n} checks passed" + ("" if p == n else f" ({n - p} FAILED)"), flush=True)
    sys.exit(0 if p == n else 1)


if __name__ == "__main__":
    main()
