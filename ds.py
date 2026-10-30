#!/usr/bin/env python3
"""DeepSeek sandbox launcher: pick a codebase, pick a mode, run it on a leash.

Run it:  python ds.py

Modes:
  review  - read-only, normal leash (ds-sandbox image)
  write   - writable copy, normal leash (ds-sandbox image)
  hunt    - read-only, FLIPPED leash for untrusted code: reading is silent,
            execution + network tools are hard-denied (ds-hunt image)

Every container runs on an internal Docker network with no route out. The only exit is the ds-proxy
container, which forwards HTTPS to the hosts in proxy/allow.txt (OpenRouter) and refuses everything else.
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
WORK = BASE / "work"
CLONES = BASE / "clones"
OUT = BASE / "out"            # write-mode results, harvested from work\ before the next run re-syncs it
NET = "ds-internal"           # internal Docker network: no route out except through the proxy
PROXY = "ds-proxy"
PROXY_URL = f"http://{PROXY}:8888"
_PROXY_ENV = [("HTTPS_PROXY", PROXY_URL), ("HTTP_PROXY", PROXY_URL), ("https_proxy", PROXY_URL),
              ("http_proxy", PROXY_URL), ("NO_PROXY", "localhost,127.0.0.1"), ("no_proxy", "localhost,127.0.0.1")]
EGRESS = ["--network", NET] + [x for k, v in _PROXY_ENV for x in ("-e", f"{k}={v}")]
# Where to look for your local repos (immediate subfolders that are git repos).
SEARCH_DIRS = [
    Path.home() / "Downloads",
    Path.home() / "Projects",
    Path.home() / "Desktop",
    Path.home() / "Desktop" / "Claude",
]
EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", "out", "output",
                "tmp", "artifacts", ".vercel", ".cache", ".idea", ".vscode", "__pycache__"]
EXCLUDE_FILES = [".env", ".env.local", ".env.*", "*.pem", "*.key", "*.p12",
                 "id_rsa", "id_rsa.pub", ".npmrc"]


def ask(prompt):
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


def find_local_repos():
    repos = []
    for d in SEARCH_DIRS:
        if not d.is_dir():
            continue
        for child in sorted(d.iterdir()):
            if child.is_dir() and (child / ".git").exists():
                repos.append(child)
    return repos


def pick_from_list():
    repos = find_local_repos()
    if not repos:
        print("No local git repos found in the usual folders. Use option 2 or 3.")
        return None
    print("\nYour local repos:")
    for i, r in enumerate(repos, 1):
        print(f"  {i:>2}) {r.name}   ({r})")
    choice = ask("\nPick a number (or blank to cancel): ")
    if not choice.isdigit() or not (1 <= int(choice) <= len(repos)):
        return None
    return repos[int(choice) - 1]


def clone_repo():
    url = ask("GitHub URL (or owner/repo): ")
    if not url:
        return None
    if "/" in url and "://" not in url and not url.startswith("git@"):
        url = f"https://github.com/{url}.git"
    name = url.rstrip("/").split("/")[-1].removesuffix(".git") or "repo"
    dest = CLONES / name
    CLONES.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if ask(f"{dest} exists. Re-clone? (y/N): ").lower() != "y":
            return dest
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(dest)])
    print(f"Cloning into {dest} ...")
    r = subprocess.run(["git", "clone", "--depth", "1", url, str(dest)])
    return dest if r.returncode == 0 and dest.exists() else None


def choose_source():
    print("\n=== DeepSeek sandbox ===")
    print("Where's the code?")
    print("  1) Pick from my local repos")
    print("  2) Enter a folder path")
    print("  3) Clone a GitHub repo")
    print("  4) Rebuild images")
    print("  5) Escape-test the sandbox (no repo, isolation check)")
    print("  q) Quit")
    c = ask("> ")
    if c == "1":
        return pick_from_list()
    if c == "2":
        p = ask("Full path to the repo folder: ").strip('"')
        path = Path(p)
        return path if path.is_dir() else (print("Not a folder.") or None)
    if c == "3":
        return clone_repo()
    if c == "4":
        build_image("ds-sandbox", "opencode.json")
        build_image("ds-hunt", "opencode.hunt.json")
        build_image("ds-escape", "opencode.escape.json")
        subprocess.run(["docker", "build", "-t", PROXY, str(BASE / "proxy")])
        quiet(["docker", "rm", "-f", PROXY])   # restart on the new image next run
        return None
    if c == "5":
        run_escape_test()
        return None
    if c.lower() == "q":
        sys.exit(0)
    return None


def build_image(name, config):
    print(f"\nBuilding image {name} ...")
    args = ["docker", "build", "-t", name]
    if config != "opencode.json":
        args += ["--build-arg", f"DS_CONFIG={config}"]
    args += [str(BASE)]
    return subprocess.run(args).returncode == 0


def ensure_image(name, config):
    r = subprocess.run(["docker", "image", "inspect", name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if r.returncode == 0:
        return True
    print(f"Image {name} not built yet.")
    return build_image(name, config)


def stage(src):
    print(f"\nStaging a cleaned copy of {src.name} ...")
    args = ["robocopy", str(src), str(WORK), "/MIR",
            "/XD", *EXCLUDE_DIRS, "/XF", *EXCLUDE_FILES,
            "/NFL", "/NDL", "/NJH", "/NJS", "/R:1", "/W:1"]
    r = subprocess.run(args, stdout=subprocess.DEVNULL)
    return r.returncode < 8  # robocopy: 0-7 = success


def quiet(args):
    return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def ensure_egress():
    """Egress lock: an internal network with no route out, plus one proxy container that forwards only to the
    hosts in proxy/allow.txt. Started on demand and reused across runs. False if it could not be brought up."""
    if not quiet(["docker", "network", "inspect", NET]):
        quiet(["docker", "network", "create", "--internal", NET])
    if not quiet(["docker", "image", "inspect", PROXY]):
        print("Building the egress proxy image ...")
        subprocess.run(["docker", "build", "-t", PROXY, str(BASE / "proxy")])
    state = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", PROXY], capture_output=True, text=True)
    if state.stdout.strip() != "true":
        quiet(["docker", "rm", "-f", PROXY])
        quiet(["docker", "run", "-d", "--rm", "--name", PROXY, "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges=true", "--read-only", "--memory", "128m", PROXY])
        quiet(["docker", "network", "connect", NET, PROXY])
    state = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", PROXY], capture_output=True, text=True)
    if state.stdout.strip() != "true":
        print(f"Egress proxy is not running. Check: docker logs {PROXY}")
        return False
    return True


def harvest(since, name):
    """After a writable run, copy files the agent created or changed out of work\\ (the next run re-syncs it)."""
    dest = OUT / f"{time.strftime('%Y%m%d-%H%M%S')}_{name}"
    n = 0
    for p in WORK.rglob("*"):
        if p.is_file() and p.stat().st_mtime >= since:
            target = dest / p.relative_to(WORK)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
            n += 1
    print(f"\nSaved {n} new/changed file(s) to {dest}" if n else "\nNo new or changed files to save.")


def run_container(image, read_only):
    if not ensure_egress():
        return
    mnt = f"{WORK}:/work" + (":ro" if read_only else "")
    args = ["docker", "run", "--rm", "-it",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges=true",
            "--pids-limit", "512", "--memory", "4g", "--cpus", "4",
            *EGRESS,
            "-e", "OPENROUTER_API_KEY",
            "-v", mnt,
            image, "opencode"]
    print(f"\nLaunching DeepSeek  [{image}, /work {'read-only' if read_only else 'WRITABLE'}]  ...\n")
    subprocess.run(args)


def run_escape_test():
    """Isolation check: NO repo mounted, caps dropped, disposable. Nothing of yours is inside.

    Uses the permissive ds-escape image (bash allowed) ON PURPOSE so the model can
    probe freely. Safe only because there is no mount -- never point this image at a repo.
    """
    if not ensure_image("ds-escape", "opencode.escape.json"):
        print("Image build failed.")
        return
    if not ensure_egress():
        return
    print("\nEscape test: NO repo mounted, caps dropped, egress locked to OpenRouter, disposable container.")
    print("Nothing of yours is in this box. Paste the escape prompt once opencode loads.\n")
    args = ["docker", "run", "--rm", "-it",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges=true",
            "--pids-limit", "512", "--memory", "2g", "--cpus", "2",
            *EGRESS,
            "-e", "OPENROUTER_API_KEY",
            "ds-escape", "opencode"]
    subprocess.run(args)


def main():
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("Warning: OPENROUTER_API_KEY is not set in this terminal.")
    while True:
        src = choose_source()
        if src is None:
            continue
        print(f"\nSelected: {src}")
        print("Mode:")
        print("  1) review  - read-only, normal leash (default)")
        print("  2) write   - writable copy, lets it edit")
        print("  3) HUNT    - untrusted code: reading silent, execution + network hard-denied")
        m = ask("> ")
        if m == "3":
            image, config, read_only = "ds-hunt", "opencode.hunt.json", True
        elif m == "2":
            image, config, read_only = "ds-sandbox", "opencode.json", False
        else:
            image, config, read_only = "ds-sandbox", "opencode.json", True
        if not ensure_image(image, config):
            print("Image build failed.")
            continue
        if not stage(src):
            print("Staging failed. Check the path and try again.")
            continue
        started = time.time() - 2          # small margin for clock skew between Windows and the container
        run_container(image, read_only)
        if not read_only:
            harvest(started, src.name)
        if ask("\nRun another? (y/N): ").lower() != "y":
            break


if __name__ == "__main__":
    main()
