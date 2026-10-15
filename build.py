#!/usr/bin/env python3
"""Inline web/ into dist/train-bot-arcade.html (offline single-file snapshot) + dist/index.html."""
import os, re
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
DIST = os.path.join(HERE, "dist")
os.makedirs(DIST, exist_ok=True)
read = lambda n: open(os.path.join(WEB, n), encoding="utf-8").read()
out = read("index.html")
out = re.sub(r'<link\s+rel="stylesheet"\s+href="app\.css"\s*/?>', lambda _m: f"<style>\n{read('app.css')}\n</style>", out)
for name in ("core.js", "app.js"):
    js = read(name).replace("</script", "<\\/script")
    out = re.sub(r'<script\s+src="' + re.escape(name) + r'"\s*>\s*</script>', lambda _m, js=js: f"<script>\n{js}\n</script>", out)
assert 'src="core.js"' not in out and 'src="app.js"' not in out and 'href="app.css"' not in out, "inline failed"
path = os.path.join(DIST, "train-bot-arcade.html")
open(path, "w", encoding="utf-8").write(out)
open(os.path.join(DIST, "index.html"), "w", encoding="utf-8").write(out)
print(f"wrote {path} ({os.path.getsize(path):,} bytes)")
