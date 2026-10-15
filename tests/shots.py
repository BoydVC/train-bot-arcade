#!/usr/bin/env python3
"""Capture gameplay screenshots at 1280x800 into screenshots/ via headless Chrome CDP.
Usage: python3 tests/shots.py   (or ./run.sh shots)
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(HERE, "screenshots")
os.makedirs(SHOTS, exist_ok=True)
subprocess.run([sys.executable, os.path.join(HERE, "build.py")], check=True)
r = subprocess.run(
    ["node", "--experimental-websocket", os.path.join(HERE, "tests", "_shots_run.mjs")],
    cwd=HERE, capture_output=True, text=True, timeout=180,
)
print(r.stdout)
if r.returncode != 0:
    print(r.stderr[-800:], file=sys.stderr)
    sys.exit(r.returncode)
for name in sorted(os.listdir(SHOTS)):
    if name.endswith(".png"):
        path = os.path.join(SHOTS, name)
        print(f"ok  {path} ({os.path.getsize(path):,} bytes)")
sys.exit(0)
