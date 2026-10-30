"""DeepSeek chat server: a private chat app for DeepSeek V4.1 Flash via OpenRouter. A copy of k2-chat with the
model backend swapped; the security design is unchanged.

- Serves the app on 127.0.0.1 only. The phone reaches it through `tailscale serve` (HTTPS, tailnet only, port 3005).
- Messages go to OpenRouter and the model provider. The API key stays in this process and never reaches a browser.
- Chats live in %LOCALAPPDATA%\\DSChat\\data, separate from K2 and outside the Downloads folder.
- After setup, chats are encrypted at rest (AES-256-GCM, key from your passphrase via scrypt).
  The key exists only in this process's memory while unlocked. Auto-lock wipes it.
- Replies are generated and saved server-side: they finish even if the phone locks mid-answer.

Usage (CMD):  python server.py
              python server.py --drop-plain-backup   (after you confirmed unlock works on laptop and phone)
"""
import base64
import hashlib
import http.cookies
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import httpx

HERE = Path(__file__).parent
OLD_DATA = HERE / "data"  # chats must never live next to the code; refuse to start if a stray copy appears here
DATA = Path(os.environ.get("DS_DATA") or Path(os.environ["LOCALAPPDATA"]) / "DSChat" / "data")
CHATS_FILE = DATA / "chats.json"           # plaintext, only before encryption is set up
VAULT_FILE = DATA / "vault.json"           # encrypted chats
PLAIN_BACKUP = DATA / "chats.plain.bak.json"
SETTINGS_FILE = DATA / "settings.json"
LOG_FILE = DATA / "server.log"
RETENTION_CHOICES = (1, 24, 168, 720, 0)   # hours after a chat's last message; 0 = keep forever
AUTO_LOCK_CHOICES = (5, 15, 30, 60, 0)     # minutes without activity; 0 = never
DEFAULT_SETTINGS = {"retention_hours": 24, "auto_lock_min": 30, "system_prompt": ""}

LOCAL_HOST = "127.0.0.1"
TAILSCALE_HOST = os.environ.get("DS_TAILSCALE", "")  # "" = no direct tailnet bind; the phone comes in via tailscale serve


def _local_setting(key):
    """Machine-specific settings live in local.json next to this file (git-ignored), so the code holds no personal
    hostnames. An environment variable DS_<KEY> overrides it."""
    env = os.environ.get(f"DS_{key.upper()}")
    if env is not None:
        return env
    try:
        return str(json.loads((HERE / "local.json").read_text("utf-8")).get(key, ""))
    except (FileNotFoundError, ValueError):
        return ""


TS_NAME = _local_setting("ts_name")  # e.g. <machine>.<tailnet>.ts.net; "" = laptop only, no phone access
TS_HOST = TS_NAME.split(".")[0] if TS_NAME else ""  # the MagicDNS short name
PORT = int(os.environ.get("DS_PORT", 3015))  # localhost only; any free port (k2-chat uses 3000)
HTTPS_PORT = 3005                             # tailscale serve terminates HTTPS here and proxies to PORT
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("DS_MODEL", "deepseek/deepseek-v4.1-flash-1017")  # fixed server-side: clients cannot pick models
THINK_END = "</ifm|think>"       # stored replies are always "thinking THINK_END answer", whatever the model
NUM_CTX = 32768                   # history budget only; the model's own window is much larger
NUM_PREDICT = 4096                # hard cap per reply (thinking + answer), so a thinking loop can't run forever
MAX_GEN_SECONDS = float(os.environ.get("DS_MAX_GEN", 180))  # wall-clock cap per reply
# History budget: what's left of the window after the reply cap and a margin, at a measured ~2.6 chars/token.
CONTEXT_CHARS = int((NUM_CTX - NUM_PREDICT - 500) * 2.6)
MAX_MESSAGE_CHARS = CONTEXT_CHARS  # a single message bigger than the whole history budget is rejected
MAX_BODY = 256 * 1024
KDF = {"n": int(os.environ.get("DS_KDF_N", 2 ** 17)), "r": 8, "p": 1}  # DS_KDF_N only lowers cost in tests
MIN_PASSPHRASE = 8

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/favicon.ico": ("icon.ico", "image/x-icon"),
}
IMG_ROUTE = re.compile(r"^/img/([A-Za-z0-9_-]{1,60}\.(png|webp|svg|jpg))$")
IMG_TYPES = {"png": "image/png", "webp": "image/webp", "svg": "image/svg+xml", "jpg": "image/jpeg"}
CHAT_ROUTE = re.compile(r"^/api/chats/([A-Za-z0-9_-]{1,40})(?:/(messages|retry|stop|keep|rename|edit))?$")

# Only answer requests addressed to this laptop by a name we expect. Blocks DNS-rebinding attacks,
# where a malicious website points its own domain at 127.0.0.1 to read your chats from your browser.
_names = [h for h in ("127.0.0.1", "localhost", TAILSCALE_HOST, TS_HOST, TS_NAME) if h]
_ts_hosts = {f"{TS_NAME}:{HTTPS_PORT}", TS_NAME} if TS_NAME else set()
ALLOWED_HOSTS = {f"{h}:{PORT}" for h in _names} | _ts_hosts
ALLOWED_ORIGINS = {f"http://{h}:{PORT}" for h in _names} | {f"https://{h}" for h in _ts_hosts}


def now_ms():
    return int(time.time() * 1000)


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def title_from(text):
    t = " ".join(text.split())
    return (t[:42] + "…") if len(t) > 42 else (t or "New chat")


def answer_of(raw):
    i = raw.find(THINK_END)
    return raw[i + len(THINK_END):].strip() if i != -1 else ""


def has_answer(m):
    # Old saves stored raw thinking as the answer when </ifm|think> never came. Never show or resend those.
    return bool(m.get("content")) and not m.get("no_answer") and not (m.get("raw") and THINK_END not in m["raw"])


def stream_openrouter(messages, stop, start, transport=None):
    """Stream one reply from OpenRouter (SSE). Yields ("think", text), ("text", text), ("error", message),
    and finally ("done", finish_reason, usage). The API key is read here and never leaves this process.
    `transport` is for tests only (httpx.MockTransport)."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        yield ("error", "OPENROUTER_API_KEY is not set in the environment this server was started from.")
        return
    req = {"model": MODEL, "messages": messages, "stream": True, "max_tokens": NUM_PREDICT}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    finish, usage = None, None
    with httpx.Client(timeout=httpx.Timeout(30.0, read=120.0), transport=transport) as hc:
        with hc.stream("POST", OPENROUTER_URL, headers=headers, json=req) as up:
            if up.status_code != 200:
                yield ("error", f"OpenRouter returned {up.status_code}: {up.read()[:300].decode(errors='replace')}")
                return
            for line in up.iter_lines():
                if stop.is_set():
                    yield ("done", "stop", usage)
                    return
                if time.time() - start > MAX_GEN_SECONDS:
                    yield ("done", "time", usage)
                    return
                if not line.startswith("data:"):
                    continue  # SSE comments and keep-alives
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue
                if obj.get("error"):
                    err = obj["error"]
                    yield ("error", f"OpenRouter error: {err.get('message', err) if isinstance(err, dict) else err}")
                    return
                usage = obj.get("usage") or usage
                ch = (obj.get("choices") or [{}])[0]
                delta = ch.get("delta") or {}
                if delta.get("reasoning"):
                    yield ("think", delta["reasoning"])
                if delta.get("content"):
                    yield ("text", delta["content"])
                finish = ch.get("finish_reason") or finish
    yield ("done", finish, usage)


def system_prompt(extra):
    d = datetime.now()
    base = (f"Today is {d:%A}, {d:%B} {d.day}, {d.year}. Trust this date and do not re-check it. "
            "Be direct and concise. Use Markdown when it helps: short lists, tables, fenced code blocks. Do not use LaTeX.")
    return base + ("\n\n" + extra.strip() if extra and extra.strip() else "")


def build_context(messages, extra_system=""):
    out, used = [], 0
    for m in reversed(messages):
        if m["role"] == "assistant" and not has_answer(m):
            continue
        if out and used + len(m["content"]) > CONTEXT_CHARS:
            break
        out.insert(0, {"role": m["role"], "content": m["content"]})
        used += len(m["content"])
    return [{"role": "system", "content": system_prompt(extra_system)}] + out


# ---------- storage ----------
def b64(b):
    return base64.b64encode(b).decode()


def unb64(s):
    return base64.b64decode(s)


def derive(passphrase, salt, kdf):
    return hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=kdf["n"], r=kdf["r"], p=kdf["p"],
                          maxmem=256 * 1024 * 1024, dklen=32)


def seal(key, obj, aad):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    data += b" " * (-len(data) % 1024)  # pad to 1 KiB so file sizes don't reveal exact lengths
    nonce = os.urandom(12)
    return {"nonce": b64(nonce), "ct": b64(AESGCM(key).encrypt(nonce, data, aad))}


def unseal(key, blob, aad):
    return json.loads(AESGCM(key).decrypt(unb64(blob["nonce"]), unb64(blob["ct"]), aad))


def chat_aad(cid):
    return f"k2v1|chat|{cid}".encode()


CHECK_AAD, SYS_AAD = b"k2v1|check", b"k2v1|sys"


def read_json(path, default):
    """Missing file -> default. Unparseable file -> refuse to continue, so a bad file is never overwritten with {}."""
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return default
    except ValueError:
        raise SystemExit(f"{path.name} is corrupt. Not starting, so it can't be overwritten. Restore it from {path.name}.bak.")


def write_json(path, obj):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False))
        f.flush()
        os.fsync(f.fileno())
    if path.exists():
        shutil.copyfile(path, path.with_name(path.name + ".bak"))  # last good version, in case of disk trouble
    os.replace(tmp, path)  # atomic: a crash never leaves a half-written file


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.unlock_lock = threading.Lock()  # one passphrase attempt at a time (scrypt is the rate limit)
        self.version = 0       # bumps on every change, including each streamed token
        self.list_version = 0  # bumps only when chats, settings or lock state change
        self.streams = {}      # chat id -> {"raw", "start", "think_ms", "stop"}
        self.settings = {**DEFAULT_SETTINGS, **read_json(SETTINGS_FILE, {})}
        self.key = None
        self.tokens = {}       # session token -> issue time. Cleared on lock.
        self.fails, self.blocked_until = 0, 0.0
        self.last_active = self.last_tick = time.time()
        self.lock_pending = False
        self.last_warm = 0.0
        self.bad = set()       # blob ids that failed to decrypt; kept on disk, never silently dropped
        vault = read_json(VAULT_FILE, None)
        if vault is not None:
            self.mode = "vault"
            self.kdf, self.salt, self.check = vault["kdf"], unb64(vault["salt"]), vault["check"]
            self.sys_blob, self.blobs = vault.get("sys"), vault["chats"]
            self.chats = {}
            self.settings["system_prompt"] = ""
        else:
            self.mode = "plain"
            self.chats = read_json(CHATS_FILE, {})
            self.blobs = {}

    # ----- state -----
    @property
    def locked(self):
        return self.mode == "vault" and self.key is None

    def changed(self, save=False, listing=True):
        self.version += 1
        if listing:
            self.list_version += 1
        if save:
            self.save()

    def save(self):
        if self.mode == "plain":
            write_json(CHATS_FILE, {cid: c for cid, c in self.chats.items() if not c.get("temp")})
            return
        if self.key is not None:
            for cid, c in self.chats.items():
                if not c.get("temp"):
                    self.blobs[cid] = {"updated": c["updated"], "keep": bool(c.get("keep")), **seal(self.key, c, chat_aad(cid))}
            for cid in [cid for cid in self.blobs if cid not in self.chats and cid not in self.bad]:
                del self.blobs[cid]
            self.sys_blob = seal(self.key, self.settings["system_prompt"], SYS_AAD)
        write_json(VAULT_FILE, {"v": 1, "kdf": self.kdf, "salt": b64(self.salt), "check": self.check,
                                "sys": self.sys_blob, "chats": self.blobs})

    def save_settings(self):
        s = dict(self.settings)
        if self.mode == "vault":
            s.pop("system_prompt", None)  # lives encrypted in the vault
        write_json(SETTINGS_FILE, s)

    def retention_ms(self):
        return self.settings["retention_hours"] * 3600 * 1000 or None

    def meta(self):
        """id -> (updated, keep) for every chat, readable even while locked."""
        if self.locked:
            return {cid: (b["updated"], b.get("keep", False)) for cid, b in self.blobs.items()}
        return {cid: (c["updated"], c.get("keep", False)) for cid, c in self.chats.items()}

    def purge(self):
        """Delete chats whose last message is older than the retention window (disappearing messages).
        Works while locked too: it only needs the plaintext timestamps, not the key."""
        with self.lock:
            keep = self.retention_ms()
            if keep is None:
                return 0
            cutoff = now_ms() - keep
            expired = [cid for cid, (updated, kept) in self.meta().items()
                       if updated < cutoff and not kept and cid not in self.streams]
            for cid in expired:
                self.chats.pop(cid, None)
                self.blobs.pop(cid, None)
                self.bad.discard(cid)
            if expired:
                self.changed(save=True)
            return len(expired)

    def update_settings(self, changes):
        with self.lock:
            self.settings.update(changes)
            self.save_settings()
            if "system_prompt" in changes and self.mode == "vault":
                self.save()
            self.changed()
        return self.purge() if "retention_hours" in changes else 0

    def summary(self):
        with self.lock:
            keep = self.retention_ms()
            items = [{"id": c["id"], "title": c["title"], "updated": c["updated"], "streaming": c["id"] in self.streams,
                      "keep": bool(c.get("keep")), "temp": bool(c.get("temp")),
                      "expires": c["updated"] + keep if keep and not c.get("keep") else None}
                     for c in self.chats.values()]
        return sorted(items, key=lambda c: -c["updated"])

    def view(self, cid):
        with self.lock:
            c = self.chats.get(cid)
            if c is None:
                return None
            s = self.streams.get(cid)
            stream = {"raw": s["raw"], "elapsed_ms": (time.time() - s["start"]) * 1000, "think_ms": s["think_ms"]} if s else None
            return {"id": c["id"], "title": c["title"], "updated": c["updated"], "keep": bool(c.get("keep")),
                    "temp": bool(c.get("temp")), "messages": list(c["messages"]), "stream": stream}

    # ----- encryption -----
    def issue_token(self):
        t = secrets.token_urlsafe(32)
        self.tokens[t] = time.time()
        return t

    def valid_token(self, t):
        return bool(t) and any(secrets.compare_digest(t, k) for k in list(self.tokens))

    def touch(self):
        self.last_active = time.time()

    def setup(self, passphrase):
        """Encrypt the plaintext chats under a new passphrase. Verifies the vault decrypts to the same data
        before the plaintext file is moved aside, so a bug can't lose chats."""
        with self.unlock_lock, self.lock:
            if self.mode != "plain":
                return 409, {"error": "Encryption is already set up."}
            if self.streams:
                return 409, {"error": "Wait for the reply to finish."}
            salt = os.urandom(16)
            key = derive(passphrase, salt, KDF)
            originals = {cid: c for cid, c in self.chats.items() if not c.get("temp")}
            blobs = {cid: {"updated": c["updated"], "keep": bool(c.get("keep")), **seal(key, c, chat_aad(cid))}
                     for cid, c in originals.items()}
            vault = {"v": 1, "kdf": KDF, "salt": b64(salt), "check": seal(key, "k2-check", CHECK_AAD),
                     "sys": seal(key, self.settings.get("system_prompt", ""), SYS_AAD), "chats": blobs}
            write_json(VAULT_FILE, vault)
            # Round trip from disk with a freshly derived key.
            disk = json.loads(VAULT_FILE.read_text("utf-8"))
            key2 = derive(passphrase, unb64(disk["salt"]), disk["kdf"])
            same = (unseal(key2, disk["check"], CHECK_AAD) == "k2-check"
                    and set(disk["chats"]) == set(originals)
                    and all(json.dumps(unseal(key2, b, chat_aad(cid)), sort_keys=True, ensure_ascii=False)
                            == json.dumps(originals[cid], sort_keys=True, ensure_ascii=False)
                            for cid, b in disk["chats"].items()))
            if not same:
                VAULT_FILE.unlink()
                return 500, {"error": "Encryption check failed. Nothing changed."}
            if CHATS_FILE.exists():
                os.replace(CHATS_FILE, PLAIN_BACKUP)
            self.mode, self.key = "vault", key
            self.kdf, self.salt, self.check = KDF, salt, vault["check"]
            self.sys_blob, self.blobs = vault["sys"], blobs
            self.save_settings()
            self.fails = 0
            self.touch()
            token = self.issue_token()
            self.changed()
            log(f"encryption set up: {len(blobs)} chat(s) encrypted")
            return 200, {"ok": True, "_token": token}

    def unlock(self, passphrase):
        with self.unlock_lock:
            wait = self.blocked_until - time.time()
            if wait > 0:
                return 429, {"error": "Too many attempts.", "retry_after": int(wait) + 1}
            key = derive(passphrase, self.salt, self.kdf)  # always verify, even if already unlocked
            try:
                ok = unseal(key, self.check, CHECK_AAD) == "k2-check"
            except (InvalidTag, ValueError):
                ok = False
            if not ok:
                self.fails += 1
                retry = min(3600, 2 ** (self.fails - 5)) if self.fails >= 5 else 0
                self.blocked_until = time.time() + retry
                log(f"unlock failed ({self.fails} in a row)")
                return 401, {"error": "Wrong passphrase.", "retry_after": retry}
            self.fails = 0
            with self.lock:
                if self.key is None:
                    chats, self.bad = {}, set()
                    for cid, b in self.blobs.items():
                        try:
                            chats[cid] = unseal(key, b, chat_aad(cid))
                        except (InvalidTag, ValueError):
                            self.bad.add(cid)
                    if self.bad:
                        log(f"{len(self.bad)} chat(s) failed to decrypt and were left on disk untouched")
                    self.chats = chats
                    self.settings["system_prompt"] = unseal(key, self.sys_blob, SYS_AAD) if self.sys_blob else ""
                    self.key = key
                    self.lock_pending = False
                self.touch()
                token = self.issue_token()
                self.changed()
            return 200, {"ok": True, "_token": token}

    def do_lock(self):
        with self.lock:
            if self.mode != "vault" or self.key is None:
                return False
            if self.streams:
                self.lock_pending = True  # the reply still needs the key to be saved
                return False
            self.key, self.chats, self.tokens, self.lock_pending = None, {}, {}, False
            self.settings["system_prompt"] = ""
            self.changed()
            log("locked")
            return True

    def tick(self):
        """Auto-lock after inactivity, or when the laptop wakes from sleep."""
        with self.lock:
            now = time.time()
            slept = now - self.last_tick > 300
            self.last_tick = now
            mins = self.settings.get("auto_lock_min", 30)
            idle = mins and now - self.last_active > mins * 60
            if not self.locked and self.mode == "vault" and (slept or idle):
                self.do_lock()

    def warm(self):
        """No-op: a hosted model has no local cold start. Kept so the unlock path stays unchanged."""
        return


store = None  # created in main, after the data-location check


class Server(ThreadingHTTPServer):
    # Python's default SO_REUSEADDR lets a second process bind the same port on Windows, which would
    # mean two servers with diverging chat state (or another program hijacking the port). Claim it exclusively.
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def csp_for(html):
    # Pin the one inline <style> block by hash, so no other inline style or script can run.
    # Browsers hash the parsed text, where CRLF and CR become LF, so normalize before hashing.
    m = re.search(rb"<style>(.*?)</style>", html, re.S)
    css = m.group(1).replace(b"\r\n", b"\n").replace(b"\r", b"\n") if m else None
    style = f"'sha256-{b64(hashlib.sha256(css).digest())}'" if m else "'none'"
    return ("default-src 'self'; script-src 'self'; style-src 'self' " + style + "; img-src 'self' data:; "
            "connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")


class Handler(BaseHTTPRequestHandler):
    server_version = "ds-chat"
    sys_version = ""
    timeout = 60  # a client that stops sending can't hold a thread forever

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def send_json(self, obj, status=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            secure = "; Secure" if self.https() else ""
            # Own cookie name: browsers don't separate cookies by port, so sharing "k2s" with k2-chat on the same
            # host would make the two apps overwrite each other's sessions.
            self.send_header("Set-Cookie", f"dss={cookie}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict{secure}")
        self.end_headers()
        self.wfile.write(body)

    def https(self):
        host = self.headers.get("Host", "")
        return bool(TS_NAME) and host.startswith(TS_NAME) and not host.endswith(f":{PORT}")

    def write_line(self, obj):
        try:
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()
            return True
        except OSError:
            return False  # client went away; keep generating so the reply still gets saved

    def allowed(self, mutating=False):
        ok = self.headers.get("Host") in ALLOWED_HOSTS
        if ok and mutating:
            # Cross-site forms can only send "simple" requests. Requiring a JSON content type forces the
            # browser to preflight, which this server never approves, so other websites can't post here.
            origin = self.headers.get("Origin")
            ok = (self.headers.get("Content-Type", "").startswith("application/json")
                  and (origin is None or origin in ALLOWED_ORIGINS))
        if not ok:
            self.send_error(403)
        return ok

    def token(self):
        c = http.cookies.SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
        except http.cookies.CookieError:
            return None
        return c["dss"].value if "dss" in c else None

    def authed(self, activity=False):
        """Gate for chat data: unlocked vault plus a session token from this device's unlock.
        Before encryption is set up, chat data stays closed and the app shows the setup screen."""
        if store.mode == "plain":
            self.send_json({"error": "locked", "setup_needed": True}, 423)
            return False
        if store.locked or store.lock_pending:
            self.send_json({"error": "locked"}, 423)
            return False
        if not store.valid_token(self.token()):
            self.send_json({"error": "unlock"}, 401)
            return False
        if activity:
            store.touch()
        return True

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > MAX_BODY:
            raise ValueError("bad length")
        return json.loads(self.rfile.read(length) or b"{}") if length else {}

    def do_GET(self):
        if not self.allowed():
            return
        path = self.path.split("?", 1)[0]
        if path in STATIC or IMG_ROUTE.match(path):
            m = IMG_ROUTE.match(path)
            name, ctype = ("img/" + m.group(1), IMG_TYPES[m.group(2)]) if m else STATIC[path]
            try:
                data = (HERE / name).read_bytes()  # re-read so edits show up without a restart
            except FileNotFoundError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if ctype.startswith("text/html"):
                self.send_header("Content-Security-Policy", csp_for(data))
            self.end_headers()
            self.wfile.write(data)
        elif path == "/api/version":
            self.send_json({"v": store.version, "lv": store.list_version, "locked": store.locked or store.mode == "plain"})
        elif path == "/api/state":
            self.send_json({"locked": store.locked or store.mode == "plain", "setup_needed": store.mode == "plain",
                            "auto_lock_min": store.settings["auto_lock_min"]})
        elif not self.authed(activity=self.headers.get("X-K2-Action") == "open"):
            return
        elif path == "/api/chats":
            self.send_json(store.summary())
        elif path == "/api/settings":
            self.send_json({**store.settings, "choices": RETENTION_CHOICES, "auto_lock_choices": AUTO_LOCK_CHOICES})
        elif (m := CHAT_ROUTE.match(path)) and not m.group(2):
            chat = store.view(m.group(1))
            self.send_json(chat) if chat else self.send_error(404)
        else:
            self.send_error(404)

    def do_DELETE(self):
        if not self.allowed(mutating=True) or not self.authed(activity=True):
            return
        m = CHAT_ROUTE.match(self.path)
        if not m or m.group(2):
            self.send_error(404)
            return
        with store.lock:
            if store.chats.pop(m.group(1), None) is None:
                self.send_error(404)
                return
            s = store.streams.get(m.group(1))
            if s:
                s["stop"].set()
            store.changed(save=True)
        self.send_json({"ok": True})

    def do_POST(self):
        if not self.allowed(mutating=True):
            return
        try:
            body = self.read_json()
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            self.send_error(400)
            return
        path = self.path
        if path in ("/api/setup", "/api/unlock"):
            pw = body.get("passphrase")
            if not isinstance(pw, str) or not pw:
                self.send_json({"error": "Type your passphrase."}, 400)
                return
            if path == "/api/setup":
                if len(pw) < MIN_PASSPHRASE:
                    self.send_json({"error": f"Use at least {MIN_PASSPHRASE} characters."}, 400)
                    return
                status, res = store.setup(pw)
            elif store.mode != "vault":
                status, res = 409, {"error": "Set up encryption first."}
            else:
                status, res = store.unlock(pw)
            token = res.pop("_token", None)
            self.send_json(res, status, cookie=token)
            if status == 200:
                store.warm()
            return
        if path == "/api/lock":
            store.do_lock()
            self.send_json({"ok": True, "pending": store.lock_pending})
            return
        if path == "/api/warm":
            if not store.locked:
                store.warm()
            self.send_json({"ok": True})
            return
        if not self.authed(activity=True):
            return
        if path == "/api/settings":
            changes = {}
            for k, ok in (("retention_hours", lambda v: v in RETENTION_CHOICES and not isinstance(v, bool)),
                          ("auto_lock_min", lambda v: v in AUTO_LOCK_CHOICES and not isinstance(v, bool)),
                          ("system_prompt", lambda v: isinstance(v, str) and len(v) <= 4000)):
                if k in body:
                    if not ok(body[k]):
                        self.send_error(400)
                        return
                    changes[k] = body[k]
            deleted = store.update_settings(changes)
            self.send_json({**store.settings, "deleted": deleted})
            return
        m = CHAT_ROUTE.match(path)
        if not m or not m.group(2):
            self.send_error(404)
            return
        cid, action = m.groups()
        if action == "stop":
            with store.lock:
                s = store.streams.get(cid)
                if s:
                    s["stop"].set()
            self.send_json({"ok": True})
            return
        if action in ("keep", "rename"):
            with store.lock:
                c = store.chats.get(cid)
                if c is None:
                    self.send_error(404)
                    return
                if action == "keep":
                    c["keep"] = bool(body.get("keep"))
                else:
                    title = " ".join(str(body.get("title", "")).split())[:80]
                    if not title:
                        self.send_error(400)
                        return
                    c["title"] = title
                store.changed(save=not c.get("temp"))
                self.send_json({"ok": True, "keep": bool(c.get("keep")), "title": c["title"]})
            return
        self.generate(cid, action, body)

    def generate(self, cid, action, body):
        text = str(body.get("text", "")).strip()
        if action in ("messages", "edit") and len(text) > MAX_MESSAGE_CHARS:
            self.send_json({"error": f"That message is too long for the chat's memory ({len(text):,} characters, "
                                     f"max {MAX_MESSAGE_CHARS:,}). Shorten it or split it up."}, 413)
            return
        with store.lock:
            if store.streams:
                self.send_json({"error": "DeepSeek is busy with another reply. Try again in a moment."}, 409)
                return
            chat = None if cid == "new" else store.chats.get(cid)
            if cid != "new" and chat is None:
                self.send_error(404)
                return
            prev_reply = None
            if action == "messages":
                if not text:
                    self.send_error(400)
                    return
                if chat is None:
                    chat = {"id": uuid.uuid4().hex[:12], "title": title_from(text), "updated": now_ms(), "messages": []}
                    if body.get("temp") is True:
                        chat["temp"] = True  # lives only in memory; gone on restart or lock
                    store.chats[chat["id"]] = chat
                chat["messages"].append({"role": "user", "content": text})
            elif action == "edit":
                i, n, msgs = body.get("index"), body.get("n"), chat["messages"] if chat else []
                if (chat is None or not text or type(i) is not int or type(n) is not int or n != len(msgs)
                        or not 0 <= i < n or msgs[i]["role"] != "user"):
                    self.send_json({"error": "This chat changed on another device. Reload and try again."}, 409)
                    return
                del msgs[i:]
                msgs.append({"role": "user", "content": text})
            else:  # retry: regenerate the last reply. The old one comes back if the new attempt fails.
                if chat is None:
                    self.send_error(404)
                    return
                if chat["messages"] and chat["messages"][-1]["role"] == "assistant":
                    prev_reply = chat["messages"].pop()
                if not chat["messages"] or chat["messages"][-1]["role"] != "user":
                    if prev_reply:
                        chat["messages"].append(prev_reply)
                    self.send_error(400)
                    return
            chat["updated"] = now_ms()
            context = build_context(chat["messages"], store.settings.get("system_prompt", ""))
            stream = {"raw": "", "start": time.time(), "think_ms": None, "stop": threading.Event()}
            store.streams[chat["id"]] = stream

        error, truncated, stats, client_ok = None, None, None, False
        try:
            # Everything after the slot is taken runs inside try, so the finally below always frees it.
            with store.lock:
                store.changed(save=not chat.get("temp"))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            client_ok = self.write_line({"chat": {"id": chat["id"], "title": chat["title"], "temp": bool(chat.get("temp"))}})
            ended = False  # THINK_END already written between thinking and answer
            for ev in stream_openrouter(context, stream["stop"], stream["start"]):
                kind = ev[0]
                if kind == "error":
                    error = ev[1]
                    break
                if kind == "done":
                    reason, usage = ev[1], ev[2]
                    if reason == "length":
                        truncated = "tokens"
                    elif reason == "time":
                        truncated = "time"
                    if usage:
                        stats = {"eval_count": usage.get("completion_tokens"), "prompt_eval_count": usage.get("prompt_tokens")}
                    break
                piece = ev[1]
                if kind == "think":  # rebuild the inline "thinking THINK_END answer" format the app and saved chats use
                    if ended:
                        continue
                elif not ended:
                    piece = f"\n{THINK_END}\n" + piece
                    ended = True
                with store.lock:
                    stream["raw"] += piece
                    if stream["think_ms"] is None and THINK_END in stream["raw"]:
                        stream["think_ms"] = (time.time() - stream["start"]) * 1000
                    store.changed(listing=False)
                if client_ok:
                    client_ok = self.write_line({"t": piece})
        except httpx.HTTPError as e:
            error = f"Can't reach OpenRouter ({e}). Check the laptop's internet connection."
        except Exception:
            error = "Server error while generating. Details are in server.log."
            traceback.print_exc()
        finally:
            with store.lock:
                store.streams.pop(chat["id"], None)
                alive = store.chats.get(chat["id"]) is chat  # deleted, purged or locked away mid-reply?
                raw = stream["raw"]
                if raw and alive:
                    answer = answer_of(raw)
                    msg = {"role": "assistant", "content": answer, "raw": raw, "thinkMs": stream["think_ms"]}
                    if not answer:
                        msg["no_answer"] = True
                    if stream["stop"].is_set():
                        msg["stopped"] = True
                    if truncated:
                        msg["truncated"] = truncated
                    if stats:
                        msg["stats"] = stats
                    chat["messages"].append(msg)
                    chat["updated"] = now_ms()
                elif prev_reply and alive:
                    chat["messages"].append(prev_reply)  # a failed retry must not destroy the old reply
                try:
                    store.changed(save=alive and not chat.get("temp"))
                except Exception:
                    traceback.print_exc()
                if store.lock_pending and not store.streams:
                    store.do_lock()
        if client_ok:
            self.write_line({"done": True, "error": error, "truncated": truncated})

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/api/version", "/api/state")):  # the 2s polling would drown the log
            sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.client_address[0]} {fmt % args}\n")


def purge_loop():
    while True:
        try:
            store.tick()
            n = store.purge()
            if n:
                log(f"auto-deleted {n} expired chat(s)")
        except Exception as e:  # never let a bad file stop the deletion schedule silently
            log(f"purge failed: {e}")
        time.sleep(15)


def serve_tailscale():
    # Tailscale may not be up yet at login, so keep retrying until its IP can be bound.
    failures = 0
    while True:
        try:
            server = Server((TAILSCALE_HOST, PORT), Handler)
            log(f"phone:  http://{TS_HOST or TAILSCALE_HOST}:{PORT}")
            server.serve_forever()
        except OSError as e:
            failures += 1
            if failures <= 3 or failures % 60 == 0:
                log(f"tailscale bind failed ({e}); retrying every 10s")
            time.sleep(10)


def drop_plain_backup():
    """Overwrite and delete plaintext leftovers once the vault is confirmed working. SSDs may keep old blocks;
    only full-disk encryption covers that."""
    for p in (PLAIN_BACKUP, CHATS_FILE.with_name("chats.json.bak"), CHATS_FILE):
        if p.exists():
            if not VAULT_FILE.exists():
                raise SystemExit("No vault.json found. Refusing to delete the only copy of your chats.")
            size = p.stat().st_size
            with open(p, "r+b") as f:
                f.write(b"\0" * size)
                f.flush()
                os.fsync(f.fileno())
            p.unlink()
            print(f"deleted {p}")


def check_test_sandbox():
    """In test mode (DS_TEST=1) the data dir must be given explicitly and must not be, or sit inside, a real one."""
    if os.environ.get("DS_TEST") != "1":
        return
    if not os.environ.get("DS_DATA"):
        raise SystemExit("Test mode needs an explicit DS_DATA temp folder.")
    if PORT in (3000, 3015):
        raise SystemExit("Test mode must not use a real port (3000 is k2, 3015 is this app).")
    d = os.path.normcase(os.path.realpath(DATA))
    real_dirs = (OLD_DATA, Path(os.environ["LOCALAPPDATA"]) / "DSChat", Path(os.environ["LOCALAPPDATA"]) / "K2")
    for real in real_dirs:
        r = os.path.normcase(os.path.realpath(real))
        if d == r or d.startswith(r.rstrip("\\/") + os.sep):
            raise SystemExit(f"Test mode refuses to run on real data: {DATA}")


def check_data_location():
    if os.environ.get("DS_DATA"):
        return
    if (OLD_DATA / "chats.json").exists() and not CHATS_FILE.exists() and not VAULT_FILE.exists():
        raise SystemExit(f"Chats are still in {OLD_DATA}. Move that folder to {DATA} first. Not starting with empty chats.")


if __name__ == "__main__":
    check_test_sandbox()  # before anything touches the data dir, including the log
    if sys.stderr is None:  # started with pythonw (no console): log to a file instead
        DATA.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 1_000_000:
            LOG_FILE.unlink()  # keep the log small; it only has times, IPs and URLs anyway
        sys.stdout = sys.stderr = open(LOG_FILE, "a", buffering=1, encoding="utf-8")
    if "--drop-plain-backup" in sys.argv:
        drop_plain_backup()
        sys.exit(0)
    try:
        check_data_location()
        store = Store()
    except SystemExit as e:
        log(f"not starting: {e}")
        raise
    try:
        local = Server((LOCAL_HOST, PORT), Handler)
    except OSError:
        log("ds-chat is already running")
        sys.exit(0)
    if TAILSCALE_HOST:
        threading.Thread(target=serve_tailscale, daemon=True).start()
    threading.Thread(target=purge_loop, daemon=True).start()
    log(f"laptop: http://{LOCAL_HOST}:{PORT}  ({store.mode}, {'locked' if store.locked else 'open'})")
    try:
        local.serve_forever()
    except KeyboardInterrupt:
        pass
