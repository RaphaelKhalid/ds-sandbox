"""Server-free tests for ds-chat's OpenRouter backend (stream_openrouter).

No HTTP server is started and nothing touches the network: requests go to an httpx.MockTransport.
    python -m unittest discover -s tests -v      (from the ds-chat folder)
"""
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import httpx  # noqa: E402
import server  # noqa: E402

KEY = {"OPENROUTER_API_KEY": "test-key"}
MSGS = [{"role": "user", "content": "hi"}]


def chunk(reasoning=None, content=None, finish=None, usage=None):
    delta = {}
    if reasoning is not None:
        delta["reasoning"] = reasoning
    if content is not None:
        delta["content"] = content
    obj = {"choices": [{"delta": delta, "finish_reason": finish}]}
    if usage:
        obj["usage"] = usage
    return obj


def sse(*items):
    """Build an SSE body. dicts become data lines, strings are written raw (comments, [DONE], junk)."""
    lines = []
    for it in items:
        lines.append(f"data: {json.dumps(it)}" if isinstance(it, dict) else it)
        lines.append("")
    return "\n".join(lines).encode()


def transport(body, status=200, seen=None):
    def handler(request):
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, content=body, headers={"content-type": "text/event-stream"})
    return httpx.MockTransport(handler)


def run(tr, stop=None, start=None):
    return list(server.stream_openrouter(MSGS, stop or threading.Event(), start or time.time(), transport=tr))


class StreamOpenRouter(unittest.TestCase):
    @mock.patch.dict(os.environ, KEY)
    def test_thinking_then_answer_then_usage(self):
        seen = []
        body = sse(chunk(reasoning="let me "), chunk(reasoning="think"), chunk(content="pine"), chunk(content="apple"),
                   chunk(finish="stop", usage={"prompt_tokens": 5, "completion_tokens": 3}), "data: [DONE]")
        ev = run(transport(body, seen=seen))
        self.assertEqual(ev[:4], [("think", "let me "), ("think", "think"), ("text", "pine"), ("text", "apple")])
        self.assertEqual(ev[-1], ("done", "stop", {"prompt_tokens": 5, "completion_tokens": 3}))
        req = seen[0]
        self.assertEqual(req.headers["authorization"], "Bearer test-key")
        sent = json.loads(req.content)
        self.assertEqual(sent["model"], server.MODEL)
        self.assertTrue(sent["stream"])
        self.assertEqual(sent["max_tokens"], server.NUM_PREDICT)
        self.assertEqual(sent["messages"], MSGS)

    @mock.patch.dict(os.environ, KEY)
    def test_comments_keepalives_and_junk_are_skipped(self):
        body = sse(": OPENROUTER PROCESSING", "data: {not json", chunk(content="ok"), "event: ping", "data: [DONE]")
        ev = run(transport(body))
        self.assertEqual([e for e in ev if e[0] == "text"], [("text", "ok")])
        self.assertEqual(ev[-1][0], "done")

    @mock.patch.dict(os.environ, KEY)
    def test_http_error_status(self):
        ev = run(transport(b'{"error":{"message":"bad key"}}', status=401))
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0][0], "error")
        self.assertIn("401", ev[0][1])

    @mock.patch.dict(os.environ, KEY)
    def test_error_object_mid_stream(self):
        body = sse(chunk(content="par"), {"error": {"message": "provider overloaded"}}, chunk(content="never"))
        ev = run(transport(body))
        self.assertEqual(ev[0], ("text", "par"))
        self.assertEqual(ev[-1][0], "error")
        self.assertIn("provider overloaded", ev[-1][1])
        self.assertNotIn(("text", "never"), ev)

    def test_missing_key_makes_no_request(self):
        seen = []
        env = {k: v for k, v in os.environ.items() if k != "OPENROUTER_API_KEY"}
        with mock.patch.dict(os.environ, env, clear=True):
            ev = run(transport(sse(chunk(content="x")), seen=seen))
        self.assertEqual(ev[0][0], "error")
        self.assertIn("OPENROUTER_API_KEY", ev[0][1])
        self.assertEqual(seen, [])

    @mock.patch.dict(os.environ, KEY)
    def test_stop_event_ends_stream(self):
        stop = threading.Event()
        stop.set()
        ev = run(transport(sse(chunk(content="a"), chunk(content="b"), "data: [DONE]")), stop=stop)
        self.assertEqual(ev[-1][:2], ("done", "stop"))
        self.assertFalse(any(e[0] == "text" for e in ev))

    @mock.patch.dict(os.environ, KEY)
    def test_wall_clock_cap(self):
        ev = run(transport(sse(chunk(content="a"), "data: [DONE]")), start=time.time() - server.MAX_GEN_SECONDS - 1)
        self.assertEqual(ev[-1][:2], ("done", "time"))

    @mock.patch.dict(os.environ, KEY)
    def test_length_finish_is_reported(self):
        ev = run(transport(sse(chunk(content="a"), chunk(finish="length"), "data: [DONE]")))
        self.assertEqual(ev[-1][:2], ("done", "length"))


class Isolation(unittest.TestCase):
    def test_own_ports_cookie_and_data_dir(self):
        self.assertEqual((server.PORT, server.HTTPS_PORT), (3015, 3005))
        self.assertEqual(server.TAILSCALE_HOST, "")
        self.assertIn("DSChat", str(server.DATA))
        self.assertNotIn("K2", str(server.DATA))
        src = (Path(server.__file__)).read_text(encoding="utf-8")
        self.assertIn('f"dss={cookie};', src)     # the cookie it sets
        self.assertIn('c["dss"].value', src)      # the cookie it reads
        self.assertNotIn("k2s={cookie}", src)
        self.assertNotIn('c["k2s"]', src)

    def test_no_personal_hostname_in_code(self):
        src = (Path(server.__file__)).read_text(encoding="utf-8")
        self.assertNotRegex(src, r'"[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net"')   # tailnet names come from local.json


if __name__ == "__main__":
    unittest.main()
