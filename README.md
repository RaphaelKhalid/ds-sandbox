# ds-sandbox

A local Docker sandbox for running DeepSeek V4.1 Flash (via OpenRouter) as a coding agent (OpenCode) against a repo, with the agent contained.

The model only emits text. OpenCode executes its commands. Both run inside a container that sees a cleaned copy of one repo and nothing else on the host, and whose only network exit is OpenRouter.

## Quick start

1. Start Docker Desktop and wait for the whale icon to settle.
2. From the `ds-sandbox` folder, run (a desktop shortcut to this works too):

   ```
   python ds.py
   ```

3. Pick the code: local repo list, a folder path, or a GitHub clone.
4. Pick a mode (below). OpenCode starts inside the container.
5. Type `exit` when done. The container is deleted.

First run of each mode builds its image (about one minute). Later runs use the cache.

## Requirements

- Windows 11 with WSL2 and Docker Desktop (WSL2 engine).
- Python 3 on PATH.
- `OPENROUTER_API_KEY` set in the user environment. Use a dedicated key with a spend cap.

## Modes

| Mode | Image | Repo mount | Commands | Edits | Use for |
|---|---|---|---|---|---|
| review | `ds-sandbox` | read-only | read/search/test allowed, rest ask, destructive and network tools denied | allowed but blocked by the read-only mount | your own repos |
| write | `ds-sandbox` | writable copy | same as review | allowed | applying changes, saving plan files |
| hunt | `ds-hunt` | read-only | read/search tools silent, execution and network tools denied | denied | untrusted code |
| escape-test | `ds-escape` | none | all allowed | allowed | checking container isolation only |

Escape-test mode is permissive on purpose. It is safe only because nothing is mounted. Never point the `ds-escape` image at a repo.

Write mode: after the container exits, `ds.py` copies every file the agent created or changed into `out\<timestamp>_<repo>\`. The next run re-syncs `work\`, so `out\` is where results survive.

## What the container gets

- A cleaned copy of the repo at `/work`. Staging excludes `.git`, `node_modules`, build output, `.env*`, key files, and `.npmrc`.
- `OPENROUTER_API_KEY`, passed by name at launch.
- Network access to `openrouter.ai:443` only, through the egress proxy (below).

What it does not get: the rest of `C:\`, your home folder, SSH keys, cloud credentials, the Docker socket.

## Container hardening (every mode)

- Non-root user `agent`.
- `--cap-drop ALL`, `--security-opt no-new-privileges=true`.
- `--pids-limit 512`, memory and CPU caps.
- `--rm`: deleted on exit.
- OpenCode config baked into the image as a root-owned file. The agent can read its rules but not rewrite them.
- Egress lock. The container sits on `ds-internal`, a Docker network created with `--internal`, so it has no route out. The only exit is the `ds-proxy` container (tinyproxy), which is on both networks and forwards HTTPS only to hosts in `proxy/allow.txt` (`openrouter.ai`). `ds.py` builds and starts it on demand. Refusals are logged: `docker logs ds-proxy`.

Egress lock verified on 2026-10-29: direct connection to a raw IP fails, the proxy refuses `example.com` (logged), OpenRouter returns 200, and a full OpenCode run works through it. During that run the proxy also refused `models.opencode.ai` (OpenCode's model catalog). OpenCode works without it.

An isolation check in escape-test mode on 2026-10-29 found: zero capabilities, NoNewPrivs=1, seccomp on, private PID namespace, no Docker socket, no host filesystem mounts, cloud metadata and Docker API unreachable.

## Known limits

- The permission rules in `opencode*.json` are pattern matching. Interpreters (`python3`, `sed`, `awk`, `find -exec`) can run other commands. The container is the real boundary, not the rules.
- The API key is readable inside the container (`/proc/*/environ`). With the egress lock it can only reach OpenRouter, which already has it. Keep the key spend-capped anyway.
- Anything sent to the model is seen by OpenRouter and the serving provider. Do not run private code you are not willing to send out.
- A container shares the WSL2 kernel. It is not a VM boundary. A kernel exploit is out of scope. WSL2's Hyper-V VM sits behind it as a second layer.
- The egress lock allows `openrouter.ai`, so data can still leave to OpenRouter. That is the price of using a hosted model. Tools that need other hosts (`npm install`, `pip install`, scanning a target) will fail inside the sandbox. To allow a host, add a line to `proxy/allow.txt` and rebuild the proxy (menu option 4).
- Pinned: the base image (`node:22-bookworm-slim` by digest), `opencode-ai@1.19.5`, and the proxy base (`debian:bookworm-slim` by digest). Not pinned: the apt packages installed at build time and `opencode-ai`'s own npm dependencies.

## Files

| File | Purpose |
|---|---|
| `ds.py` | Menu launcher. Stages the copy, builds images on demand, starts the egress proxy, runs the container, saves write-mode results. |
| `Dockerfile` | Image: Node 22 Debian slim (pinned), OpenCode 1.19.5, non-root user, baked config. `DS_CONFIG` build arg picks the config. |
| `proxy/` | Egress proxy image: `Dockerfile`, `tinyproxy.conf`, `allow.txt` (the allowlist). |
| `opencode.json` | Review/write leash. |
| `opencode.hunt.json` | Hunt leash. |
| `opencode.escape.json` | Escape-test config (permissive). |
| `work\` | Scratch staging folder. Re-synced every run. Not in git. |
| `out\` | Write-mode results, one folder per run. Not in git. |
| `clones\` | Repos cloned through the menu. Not in git. Safe to delete; re-clone from the menu. |
| `headless-test\` | Smoke-test fixture (one file, known answer). |
| `ds-chat\` | Chat app for laptop and phone. See "Chat mode". |

The folder is a git repo. `.gitattributes` keeps LF line endings on files that run inside Linux containers.

## Rebuilding

Menu option 4 rebuilds all three images and the proxy. Manual equivalent, from the `ds-sandbox` folder:

```
docker build -t ds-sandbox .
docker build -t ds-hunt --build-arg DS_CONFIG=opencode.hunt.json .
docker build -t ds-escape --build-arg DS_CONFIG=opencode.escape.json .
docker build -t ds-proxy proxy
docker rm -f ds-proxy
```

To move to a newer OpenCode or base image, change the pin in `Dockerfile` on purpose, rebuild, and rerun the smoke test.

## Calling it from another app

The images can run OpenCode headless with `opencode run "<prompt>"`. Output goes to stdout. Keep the hardening flags. Example from Python:

```python
import re
import subprocess
import sys

sys.path.insert(0, r"C:\path\to\ds-sandbox")  # where you cloned this repo
import ds  # reuse the launcher's egress lock: same network, proxy and flags

ANSI = re.compile(r"\x1b\[[0-9;]*m")

def run_sandboxed(prompt: str, work_dir: str, image: str = "ds-hunt", timeout: int = 1800) -> str:
    """Returns the full stdout with ANSI codes stripped: the agent's tool trace, then its answer."""
    if not ds.ensure_egress():
        raise RuntimeError("egress proxy is not running")
    args = [
        "docker", "run", "--rm",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true",
        "--pids-limit", "512", "--memory", "4g", "--cpus", "4",
        *ds.EGRESS,
        "-e", "OPENROUTER_API_KEY",
        "-v", f"{work_dir}:/work:ro",
        image, "opencode", "run", prompt,
    ]
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return ANSI.sub("", r.stdout)
```

Output format (from a real run): a header line naming the agent and model, then each tool call the agent made (`$ ls -la /work`, `→ Read hello.txt`) with its output, then the model's answer as the last line(s). Parse the answer from the end, or ask the model to wrap it in a marker you can search for.

Notes for callers:

- Stage and clean the repo yourself first, the way `ds.py` does. Do not mount a real repo or a folder holding secrets.
- Headless runs cannot answer permission prompts. Commands that would "ask" will stall or be refused. Hunt mode is the closest fit because it has almost no "ask" cases.
- Tested end to end on 2026-10-29 with `ds-hunt` against `headless-test\` (one file, known answer), through the egress lock, on the pinned images. Exit 0, correct answer, no stalls. Rerun that check after any image rebuild, from the `ds-sandbox` folder in CMD:

  ```
  python -c "import ds; ds.ensure_egress()"
  docker run --rm --cap-drop ALL --security-opt no-new-privileges=true --network ds-internal -e HTTPS_PROXY=http://ds-proxy:8888 -e HTTP_PROXY=http://ds-proxy:8888 -e https_proxy=http://ds-proxy:8888 -e http_proxy=http://ds-proxy:8888 -e OPENROUTER_API_KEY -v "%CD%\headless-test:/work:ro" ds-hunt opencode run "Read the file in /work and tell me the secret word it contains. Answer in one sentence."
  ```

  Expected: the answer says "pineapple".
- If you score model output in an eval, do not use DeepSeek to grade its own answers.

## Chat mode (laptop and phone)

`ds-chat\` is a plain chat app for DeepSeek V4.1 Flash. It is derived from k2-chat (the author's local chat app for Ollama models, not included here), with the Ollama backend swapped for OpenRouter. It runs no commands, so it does not use Docker.

- Start: `pythonw launch.pyw` in `ds-chat\` starts the server if needed and opens an app window (a desktop shortcut to it works well). Or run `python server.py` to see the log.
- Laptop: `http://127.0.0.1:3015` (localhost only).
- Phone: `https://<machine>.<tailnet>.ts.net:3005` (tailnet only). Needs `local.json` and a one-time `tailscale serve` mapping, below.
- First open: choose a passphrase. Chats are encrypted at rest in `%LOCALAPPDATA%\DSChat\data`. There is no reset.
- Messages go to OpenRouter and the model provider. The API key stays in the server process and never reaches the browser.
- The server needs `OPENROUTER_API_KEY` in its environment. If replies say it is not set, sign out and back in so Explorer picks up the variable.
- Same security design as k2-chat: Host and Origin checks, CSP, HttpOnly SameSite=Strict cookie, auto-lock, auto-delete. Own cookie name (`dss`), so it does not clash with k2's session on the same host.

Phone access, one time:

1. Create `ds-chat\local.json` (git-ignored, so your tailnet name never lands in the repo) with your machine's Tailscale name. Or set the `DS_TS_NAME` environment variable instead.

   ```json
   {"ts_name": "<machine>.<tailnet>.ts.net"}
   ```

2. Publish the local port on your tailnet over HTTPS:

   ```
   tailscale serve --bg --https=3005 http://127.0.0.1:3015
   ```

Without `local.json` the app runs laptop-only and refuses requests addressed to any other host name.

Ports: 3015 on localhost (`DS_PORT` to change), 3005 on the tailnet (`HTTPS_PORT` in `server.py`). Pick ones your Tailscale ACL allows.

Start at login (optional): make a shortcut that runs `pythonw.exe server.py` with `ds-chat\` as its working folder, then press Win+R, type `shell:startup`, and put the shortcut there. It starts the server in the background with no window.

Tests: `python -m unittest discover -s tests -v` from `ds-chat\`. Ten server-free tests cover the OpenRouter backend (thinking then answer, usage, SSE comments and junk, HTTP errors, mid-stream errors, missing key, stop, time cap, length), check that the ports, data folder and cookie name don't collide with k2-chat, and check that no tailnet name is hardcoded. No HTTP server starts and nothing touches the network.

Icons: `python make_icons.py` redraws the "DS" icons. The unlock and empty-state artwork in `ds-chat\img\` comes from k2-chat and is not in this repo. Without it those screens show no art; everything else works.

Tested 2026-10-29: the live OpenRouter stream returns thinking, then the answer, with usage, in about 1.5 s for a one-word reply. The full server and UI were not started from an agent shell. Check them on first launch.
