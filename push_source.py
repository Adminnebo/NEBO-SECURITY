"""Push the prepared source; a short-lived Git token arrives only on stdin."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
credential = json.load(sys.stdin)
env = os.environ.copy()
env.update({
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "http.extraHeader",
    "GIT_CONFIG_VALUE_0": "Authorization: Bearer " + credential["token"],
})
git = r"C:\Program Files\Git\cmd\git.exe"
result = subprocess.run(
    [git, "push", credential["remote_url"], "HEAD:" + credential["branch"]],
    cwd=root, env=env, capture_output=True, text=True,
)
output = (result.stdout + result.stderr).replace(credential["token"], "[REDACTED]")
print(output, end="")
if result.returncode:
    sys.exit(result.returncode)
print(subprocess.check_output([git, "rev-parse", "--verify", "HEAD"], cwd=root, text=True).strip())
