"""Desktop button: start the DeepSeek Chat server if it isn't running, then open the app in its own window.

Runs with pythonw, so no console window appears.
"""
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).parent
URL = "http://127.0.0.1:3015"  # localhost counts as a secure context, so copy-to-clipboard works natively


def server_up():
    try:
        socket.create_connection(("127.0.0.1", 3015), timeout=0.5).close()
        return True
    except OSError:
        return False


if not server_up():
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    subprocess.Popen(
        [str(pythonw if pythonw.exists() else sys.executable), str(HERE / "server.py")],
        cwd=HERE,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    for _ in range(50):
        if server_up():
            break
        time.sleep(0.1)

chrome_paths = [
    Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
]
chrome = next((p for p in chrome_paths if p.exists()), None)
# A dedicated profile with no extensions: browser extensions in your main profile can read any open page,
# including decrypted chats. --user-data-dir also makes Chrome honor the flags instead of handing the URL
# to an already-running browser.
PROFILE = Path(os.environ["LOCALAPPDATA"]) / "DSChat" / "chrome-profile"
if chrome:
    subprocess.Popen([str(chrome), f"--user-data-dir={PROFILE}", "--disable-extensions", "--no-first-run",
                      "--no-default-browser-check", f"--app={URL}"])  # app window: no tabs or address bar
else:
    webbrowser.open(URL)
