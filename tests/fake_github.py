"""A fake GitHub for testing the viewer in a real browser, with no sign-in.

Serves docs/ at / (with a config.js pointing the viewer at this server) and enough of
the REST API under /api for the viewer: /user, /repos/<o>/<r>, and contents GET/PUT on a
folder laid out as a paper store. Like GitHub it sends an ETag and lets browsers cache
contents for 60 s, but it sends no `Vary: Accept`, so a browser cache that ignores the
Accept header (as a phone's did) is the default here. That is the case that broke saves.

    uv run --with pytest python tests/fake_github.py [store-folder]   # then open the printed URL
"""
import base64
import hashlib
import json
import shutil
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

DOCS = Path(__file__).resolve().parents[1] / "docs"
REPO = "test/store"


def sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class FakeGitHub:
    def __init__(self, store):
        self.store = Path(store)
        self.commits = []   # (path, message) of each accepted PUT
        self.polls = 0      # device-flow polls; the second one is approved
        self.push = True    # False: a read-only collaborator
        self.conflicts = 0  # this many PUTs answer 409, as if someone else saved first
        self.signed_out = False   # every API call answers 401
        self.lock = threading.Lock()
        fake = self

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *a, **k):
                super().__init__(*a, directory=str(DOCS), **k)

            def log_message(self, *a):
                pass

            def send(self, code, body=b"", ctype="application/json", headers=()):
                if isinstance(body, (dict, list)):
                    body = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in headers:
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def api(self):
                u = urlsplit(self.path)
                return u.path[len("/api"):] if u.path.startswith("/api/") else None

            def do_GET(self):
                if urlsplit(self.path).path == "/config.js":
                    base = f"http://{self.headers['Host']}"
                    cfg = {"repo": REPO, "branch": "main", "auth": base + "/auth", "demo": "demo/", "api": base + "/api"}
                    return self.send(200, f"window.PAPERSTORE = {json.dumps(cfg)};".encode(), "text/javascript")
                p = self.api()
                if p is None:
                    return super().do_GET()
                if fake.signed_out or not self.headers.get("Authorization", "").startswith("Bearer "):
                    return self.send(401, {"message": "Requires authentication"})
                if p == "/user":
                    return self.send(200, {"login": "tester"})
                if p == f"/repos/{REPO}":
                    return self.send(200, {"full_name": REPO, "permissions": {"push": fake.push, "admin": False}})
                prefix = f"/repos/{REPO}/contents/"
                if not p.startswith(prefix):
                    return self.send(404, {"message": "Not Found"})
                rel = unquote(p[len(prefix):])
                f = fake.store / rel
                if f.is_dir():
                    return self.send(200, [{"name": c.name, "path": f"{rel}/{c.name}", "type": "dir" if c.is_dir() else "file"} for c in sorted(f.iterdir())])
                if not f.is_file():
                    return self.send(404, {"message": "Not Found"})
                with fake.lock:
                    data = f.read_bytes()
                etag = f'"{sha(data)}{"r" if "raw" in self.headers.get("Accept", "") else "j"}"'
                if self.headers.get("If-None-Match") == etag:
                    return self.send(304, headers=[("ETag", etag)])
                cache = [("ETag", etag), ("Cache-Control", "private, max-age=60, s-maxage=60")]
                if "raw" in self.headers.get("Accept", ""):
                    return self.send(200, data, "application/octet-stream", cache)
                return self.send(200, {"name": f.name, "path": rel, "sha": sha(data), "size": len(data), "type": "file",
                                       "encoding": "base64", "content": base64.encodebytes(data).decode()}, headers=cache)

            def do_POST(self):   # the sign-in helper's device flow (worker/worker.js)
                path = urlsplit(self.path).path
                if path == "/auth/device":
                    return self.send(200, {"device_code": "dev123", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device",
                                           "interval": 1, "expires_in": 900})
                if path == "/auth/device/poll":
                    fake.polls += 1
                    if fake.polls < 2:
                        return self.send(200, {"error": "authorization_pending"})
                    return self.send(200, {"access_token": "fake-device-token", "refresh_token": "r", "expires_in": 28800})
                return self.send(404, {"message": "Not Found"})

            def do_PUT(self):
                p = self.api()
                prefix = f"/repos/{REPO}/contents/"
                if p is None or not p.startswith(prefix):
                    return self.send(404, {"message": "Not Found"})
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                f = fake.store / unquote(p[len(prefix):])
                with fake.lock:
                    if fake.conflicts:
                        fake.conflicts -= 1
                        return self.send(409, {"message": "is at another sha"})
                    current = sha(f.read_bytes()) if f.exists() else None
                    if body.get("sha") != current:
                        return self.send(409 if current else 422, {"message": "sha does not match"})
                    data = base64.b64decode(body["content"])
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_bytes(data)
                    fake.commits.append((str(f.relative_to(fake.store)).replace("\\", "/"), body["message"]))
                return self.send(200, {"content": {"sha": sha(data)}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/"

    def start(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.server.shutdown()


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DOCS / "demo"
    tmp = Path(tempfile.mkdtemp()) / "store"
    shutil.copytree(src, tmp)
    g = FakeGitHub(tmp).start()
    print(f"{g.url}  (store copy: {tmp}; any token works, set localStorage ps.token)")
    threading.Event().wait()
