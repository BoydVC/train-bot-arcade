"""Train-a-Bot Arcade server on 127.0.0.1:4356 (stdlib). Env: TBA_PORT."""
import http.server, json, os, socketserver
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("TBA_PORT", "4356"))
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/healthz":
            dist = os.path.join(HERE, "dist", "train-bot-arcade.html")
            body = json.dumps({"ok": True, "app": "train-bot-arcade", "port": PORT,
                               "dist_bytes": os.path.getsize(dist) if os.path.isfile(dist) else 0}).encode()
            return self._send(200, body, "application/json")
        rel = {"/": "dist/train-bot-arcade.html", "/index.html": "dist/train-bot-arcade.html",
               "/train-bot-arcade.html": "dist/train-bot-arcade.html"}.get(p)
        if not rel:
            if p.startswith("/web/") or p.startswith("/screenshots/"):
                rel = os.path.normpath(p.lstrip("/"))
                if rel.startswith(".."):
                    return self._send(404, b"not found", "text/plain")
            else:
                return self._send(404, b"not found", "text/plain")
        path = os.path.join(HERE, rel)
        if not os.path.isfile(path):
            return self._send(404, b"not found", "text/plain")
        data = open(path, "rb").read()
        ct = "text/html; charset=utf-8"
        if path.endswith(".css"): ct = "text/css; charset=utf-8"
        elif path.endswith(".js"): ct = "application/javascript; charset=utf-8"
        elif path.endswith(".png"): ct = "image/png"
        self._send(200, data, ct)
    def _send(self, code, body, ct):
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
if __name__ == "__main__":
    print(f"Train-a-Bot Arcade on http://127.0.0.1:{PORT}", flush=True)
    S(("127.0.0.1", PORT), H).serve_forever()
