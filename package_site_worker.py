"""Package committed NEBO Worker code and assets without reading runtime data.

Sources are read exclusively from ``git archive HEAD``. No existing ``dist``
directory is read, rewritten, or removed. The archive follows the Sites Worker
layout: dist/server, dist/client and dist/.openai/hosting.json.

This script does not deploy, provision D1, change audience, or copy secrets.
Private application assets are embedded inside a Worker module instead of the
static asset directory, so an asset-first hosting router cannot expose them.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile


INPUTS = ("public", "worker", ".openai/hosting.json", "drizzle")
RECIPES = ("package_site_worker.py", "wrangler.local.jsonc")
EXPECTED_PROJECT = "appgprj_6aad65cb7a74819183d7ad8f42fc071c"
PUBLIC_ENTRY_FILES = {"login.js", "auth.css", "theme.js"}
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".wasm": "application/wasm",
}
RUNTIME_MODULES = {"node:crypto", "node:buffer", "cloudflare:workers"}
IMPORT = re.compile(
    r"(?:\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?|\bimport\s*\()"
    r"[\"']([^\"']+)[\"']"
)


def git(root: Path, *args: str) -> bytes:
    executable = shutil.which("git")
    if not executable:
        raise RuntimeError("Git is required to package the exact committed source.")
    return subprocess.check_output([executable, *args], cwd=root)


def require(condition: bool, explanation: str) -> None:
    if not condition:
        raise ValueError(explanation)


def safe_source_path(name: str) -> None:
    path = PurePosixPath(name)
    require(not path.is_absolute() and ".." not in path.parts, "Unsafe source path.")
    require("\\" not in name, "Backslash in archive member path.")
    forbidden_parts = {"node_modules", ".git", ".wrangler", "__pycache__"}
    require(not forbidden_parts.intersection(path.parts), "Runtime/dependency files cannot be packaged.")
    lower = path.name.lower()
    require(not lower.startswith((".env", ".dev.vars")), "Environment files cannot be packaged.")
    require(not lower.endswith((".pem", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db", ".key", ".key.txt")),
            "Private keys/databases cannot be packaged.")


def is_public_asset(path: str) -> bool:
    return path.startswith(("assets/", "vendor/")) or path in PUBLIC_ENTRY_FILES


def private_assets_module(files: dict[str, bytes]) -> bytes:
    """Generate a deterministic ESM asset responder, never a public asset file."""
    entries = {}
    for source_path, data in sorted(files.items()):
        if not source_path.startswith("public/"):
            continue
        path = source_path[len("public/"):]
        if is_public_asset(path):
            continue
        entries["/" + path] = [
            MIME_TYPES.get(PurePosixPath(path).suffix, "application/octet-stream"),
            base64.b64encode(data).decode("ascii"),
        ]
    require("/index.html" in entries, "Missing private application HTML.")
    payload = json.dumps(entries, separators=(",", ":"), ensure_ascii=True)
    module = """// Generated from application assets; never publish as a static client file.
const assets = Object.freeze(%s);
export function servePrivateAsset(request, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = pathname.startsWith('/') ? pathname : '/' + pathname;
  if (!Object.hasOwn(assets, path)) return null;
  const [mime, encoded] = assets[path];
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return new Response(bytes, { headers });
}
""" % payload
    return module.encode("utf-8")


def generate_development_assets(root: Path) -> dict:
    """Local-only generation; .dev.vars and other runtime state stay untouched."""
    root = root.resolve()
    public = root / "public"
    require(public.is_dir(), "Missing public source directory.")
    require((root / "worker").is_dir(), "Create the Worker source directory first.")
    files = {}
    for path in sorted(public.rglob("*")):
        require(not path.is_symlink(), "Symlinks are not allowed in application assets.")
        if not path.is_file():
            continue
        source_path = path.relative_to(root).as_posix()
        safe_source_path(source_path)
        files[source_path] = path.read_bytes()
    module = private_assets_module(files)
    destination = root / "worker" / "site-assets.js"
    destination.write_bytes(module)
    return {"generated": str(destination), "bytes": len(module), "mode": "local-development-only"}


def read_committed_inputs(root: Path) -> tuple[str, int, dict[str, bytes]]:
    sha = git(root, "rev-parse", "--verify", "HEAD").decode().strip()
    require(bool(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha)), "Invalid full Git object ID.")
    # Includes staged and unstaged differences; untracked files cannot enter git archive.
    git(root, "diff", "--quiet", "HEAD", "--", *INPUTS, *RECIPES)
    tracked = set(git(root, "ls-tree", "-r", "--name-only", "HEAD").decode().splitlines())
    for required in ("public/index.html", "worker/index.js", "worker/auth.js", ".openai/hosting.json", *RECIPES):
        require(required in tracked, f"Commit required build input first: {required}")
    require("worker/site-assets.js" not in tracked, "Do not commit generated worker/site-assets.js; it is rebuilt from committed public assets.")
    timestamp = int(git(root, "show", "-s", "--format=%ct", sha).decode().strip())
    included = [name for name in INPUTS if any(p == name or p.startswith(name + "/") for p in tracked)]
    source = git(root, "archive", "--format=tar", sha, *included)
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(source), mode="r:") as archive:
        for member in archive:
            safe_source_path(member.name)
            if member.isdir():
                continue
            require(member.isfile(), "Symlinks, devices, and other special files cannot be packaged.")
            handle = archive.extractfile(member)
            require(handle is not None, "Unable to read committed source.")
            require(member.name not in files, "Duplicate source entry.")
            files[member.name] = handle.read()
    return sha, timestamp, files


def validate_worker_modules(files: dict[str, bytes]) -> None:
    """Reject unresolved imports instead of shipping an accidental Node project."""
    modules = {name: data for name, data in files.items() if name.startswith("worker/")}
    require(all(PurePosixPath(name).suffix in {".js", ".mjs"} for name in modules),
            "Worker directory must contain only deployable JavaScript modules.")
    for name, data in modules.items():
        source = data.decode("utf-8")
        for specifier in IMPORT.findall(source):
            if specifier in RUNTIME_MODULES:
                continue
            require(specifier.startswith("./"),
                    f"Bundle unsupported dependency before deployment: {specifier} in {name}")
            target = str(PurePosixPath(name).parent / specifier)
            require(".." not in PurePosixPath(specifier).parts and target in modules,
                    f"Unresolved Worker module import: {specifier} in {name}")
    require(re.search(r"\bexport\s+default\b", files["worker/index.js"].decode("utf-8")) is not None,
            "Worker entry must provide an ESM default export.")


def deployment_files(files: dict[str, bytes]) -> dict[str, bytes]:
    config = json.loads(files[".openai/hosting.json"])
    require(config.get("project_id") == EXPECTED_PROJECT, "Unexpected Sites project ID; preserve the existing project.")
    require(config.get("d1") == "DB" and config.get("r2") is None, "Expected managed D1 binding DB and no R2 binding.")
    require("static" not in config, "Worker deployment must not use static-only hosting configuration.")
    require(set(config).issubset({"project_id", "d1", "r2"}), "Unexpected hosting metadata; do not package runtime secrets.")
    private_module = private_assets_module(files)
    validate_worker_modules({**files, "worker/site-assets.js": private_module})
    result: dict[str, bytes] = {"dist/server/site-assets.js": private_module}
    for name, data in files.items():
        if name.startswith("public/"):
            if not is_public_asset(name[len("public/"):]):
                continue
            destination = "dist/client/" + name[len("public/"):]
        elif name.startswith("worker/"):
            destination = "dist/server/" + name[len("worker/"):]
        elif name == ".openai/hosting.json":
            destination = "dist/.openai/hosting.json"
        elif name.startswith("drizzle/"):
            destination = "dist/.openai/" + name
        else:
            raise ValueError("Unexpected committed source in build.")
        require(destination not in result, "Duplicate deployment path.")
        result[destination] = data
    return result


def verify_archive(path: Path, expected: dict[str, bytes]) -> None:
    with tarfile.open(path, "r:") as archive:
        members = archive.getmembers()
        require(len(members) == len(expected), "Unexpected archive member count.")
        require(set(archive.getnames()) == set(expected), "Archive contents differ from committed build inputs.")
        for member in members:
            require(member.isfile(), "Deployment archive must contain regular files only.")
            require(member.name.startswith(("dist/client/", "dist/server/", "dist/.openai/")), "Unexpected output path.")
            actual = archive.extractfile(member).read()
            require(actual == expected[member.name], "Archive bytes differ from committed source.")
        require("dist/server/index.js" in expected and "dist/server/site-assets.js" in expected,
                "Incomplete Worker deployment.")
        require("dist/client/index.html" not in expected, "Private HTML must not be a static asset.")
        require(all(is_public_asset(name[len("dist/client/"):]) for name in expected if name.startswith("dist/client/")),
                "Private application asset in static output.")
        require("dist/.openai/hosting.json" in expected, "Missing Sites deployment metadata.")


def package(root: Path, output: Path) -> dict:
    root = root.resolve()
    output = output.resolve()
    require(output.suffix == ".tar", "Output must be an uncompressed .tar archive.")
    require(output.parent.is_dir(), "Output parent must already exist.")
    sha, timestamp, source = read_committed_inputs(root)
    files = deployment_files(source)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".nebo-worker-package-", suffix=".tar", dir=output.parent, delete=False) as temp:
            temp_path = Path(temp.name)
        with tarfile.open(temp_path, "w", format=tarfile.PAX_FORMAT) as archive:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o644
                member.mtime = timestamp
                archive.addfile(member, io.BytesIO(data))
        verify_archive(temp_path, files)
        require(git(root, "rev-parse", "--verify", "HEAD").decode().strip() == sha,
                "Git HEAD changed during packaging; retry from the intended source commit.")
        temp_path.replace(output)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return {
        "archive": str(output),
        "commit_sha": sha,
        "files": len(files),
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "project_id": EXPECTED_PROJECT,
        "entrypoint": "dist/server/index.js",
        "private_assets_embedded_in_worker": True,
        "private_assets_module_bytes": len(files["dist/server/site-assets.js"]),
        "production_auth_routing_requires_verification": True,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dev-assets", action="store_true", help="Generate ignored worker/site-assets.js from working public files for local tests.")
    args = parser.parse_args()
    if args.dev_assets:
        require(args.output is None, "--output is not used with --dev-assets.")
        print(json.dumps(generate_development_assets(args.project), ensure_ascii=False))
    else:
        destination = args.output or args.project.resolve().parent / "ASTRA_WEB_WORKER_DEPLOY.tar"
        print(json.dumps(package(args.project, destination), ensure_ascii=False))
