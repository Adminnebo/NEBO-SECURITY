"""Package only committed static assets and hosting config, never private inputs."""
from pathlib import Path
import json
import subprocess
import tarfile

root = Path(__file__).resolve().parent
git = r"C:\Program Files\Git\cmd\git.exe"
archive = root.parent / "ASTRA_WEB_DEPLOY.tar"
sha = subprocess.check_output([git, "rev-parse", "--verify", "HEAD"], cwd=root, text=True).strip()
subprocess.run([git, "diff", "--exit-code", "HEAD", "--", "public", ".openai/hosting.json"], cwd=root, check=True)
subprocess.run([git, "archive", "--format=tar", "--output=" + str(archive), sha, "public", ".openai/hosting.json"], cwd=root, check=True)
with tarfile.open(archive) as tar:
    names = tar.getnames()
    assert "public/index.html" in names and "public/codec-worker.js" in names
    assert all(n == ".openai" or n == ".openai/hosting.json" or n == "public" or n.startswith("public/") for n in names)
    config = json.load(tar.extractfile(".openai/hosting.json"))
    assert config["static"]["directory"] == "public"
    assert config["project_id"]
print(json.dumps({"archive": str(archive), "commit_sha": sha, "files": len(names), "bytes": archive.stat().st_size}))
