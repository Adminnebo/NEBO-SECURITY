"""Package only committed static assets and hosting config, never private inputs."""
from pathlib import Path
import json
import io
import subprocess
import tarfile

root = Path(__file__).resolve().parent
git = r"C:\Program Files\Git\cmd\git.exe"
archive = root.parent / "ASTRA_WEB_DEPLOY.tar"
sha = subprocess.check_output([git, "rev-parse", "--verify", "HEAD"], cwd=root, text=True).strip()
subprocess.run([git, "diff", "--exit-code", "HEAD", "--", "public", ".openai/hosting.json"], cwd=root, check=True)
source = subprocess.check_output([git, "archive", "--format=tar", sha, "public", ".openai/hosting.json"], cwd=root)
with tarfile.open(fileobj=io.BytesIO(source)) as inputs, tarfile.open(archive, "w") as output:
    for member in inputs.getmembers():
        data = inputs.extractfile(member) if member.isfile() else None
        if member.name == "public" or member.name.startswith("public/"):
            member.name = "dist" + member.name[len("public"):]
        output.addfile(member, data)
with tarfile.open(archive) as tar:
    names = tar.getnames()
    assert "dist/index.html" in names and "dist/codec-worker.js" in names
    assert all(n == ".openai" or n == ".openai/hosting.json" or n == "dist" or n.startswith("dist/") for n in names)
    config = json.load(tar.extractfile(".openai/hosting.json"))
    assert config["static"]["directory"] == "dist"
    assert config["project_id"]
print(json.dumps({"archive": str(archive), "commit_sha": sha, "files": len(names), "bytes": archive.stat().st_size}))
