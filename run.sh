#!/usr/bin/env bash
# Train-a-Bot Arcade: ./run.sh build|start|stop|restart|status|shots|test|all
set -euo pipefail
cd "$(dirname "$0")"
PORT="${TBA_PORT:-4356}"
PIDF=data/server.pid
LOG=data/server.log
mkdir -p data dist screenshots tests
status(){ if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then echo "running on http://127.0.0.1:$PORT (pid $(cat "$PIDF"))"; else echo "not running"; return 1; fi; }
start(){ if status >/dev/null 2>&1; then status; return; fi; python3 build.py; setsid nohup python3 server.py >>"$LOG" 2>&1 < /dev/null & echo $! > "$PIDF"; sleep 0.6; status; }
stop(){ [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF"; echo stopped; }
build(){ python3 build.py; }
case "${1:-start}" in
  build) build;;
  start) start;;
  stop) stop;;
  restart) stop; start;;
  status) status;;
  shots) build; python3 tests/shots.py;;
  test) build; python3 tests/smoke_test.py;;
  all) build; python3 tests/shots.py; python3 tests/smoke_test.py; start;;
  *) echo "usage: $0 build|start|stop|restart|status|shots|test|all"; exit 2;;
esac
