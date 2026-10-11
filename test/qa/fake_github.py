# Minimal fake of the GitHub Contents + Trees API for local testing.
import base64, hashlib, json, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
files = {}
def put(path, text): files[path] = text
def sha(t): return hashlib.sha1(t.encode()).hexdigest()
for path, text in json.load(open(sys.argv[1])).items(): put(path, text)
class H(BaseHTTPRequestHandler):
    def send(self, code, obj=None):
        body = json.dumps(obj or {}).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
    def path_of(self):
        m = re.match(r"^/repos/[^/]+/[^/]+/contents/([^?]+)", self.path)
        from urllib.parse import unquote
        return unquote(m.group(1)) if m else None
    def do_GET(self):
        if "/git/trees/" in self.path:
            return self.send(200, {"truncated": False, "tree": [{"path": p, "type": "blob"} for p in files]})
        p = self.path_of()
        if p in files: return self.send(200, {"type": "file", "encoding": "base64", "content": base64.b64encode(files[p].encode()).decode(), "sha": sha(files[p])})
        self.send(404, {"message": "Not Found"})
    def do_PUT(self):
        p = self.path_of(); b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if p in files and b.get("sha") != sha(files[p]): return self.send(409, {})
        if p not in files and b.get("sha"): return self.send(409, {})
        files[p] = base64.b64decode(b["content"]).decode(); self.send(201, {"content": {"path": p}})
    def do_DELETE(self):
        p = self.path_of()
        if p not in files: return self.send(404, {})
        del files[p]; self.send(200, {})
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", 8798), H).serve_forever()
