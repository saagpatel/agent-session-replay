#!/usr/bin/env python3
"""Export a git commit as an immutable watchdog release dir with a generation manifest.

Usage: build-watchdog-release.py <repo> <commit> <out-dir>
Out-dir is normally ~/.local/state/agent-watchdog/releases/<full-commit>.
Output matches the WatchdogGenerationManifestV1 layout byte for byte.
"""
import hashlib, io, json, os, subprocess, sys, tarfile
repo, commit, out = sys.argv[1], sys.argv[2], sys.argv[3]
commit = subprocess.check_output(["git", "-C", repo, "rev-parse", commit + "^{commit}"], text=True).strip()
if os.path.exists(out):
    sys.exit(f"refusing: {out} exists")
tar = subprocess.check_output(["git", "-C", repo, "archive", "--format=tar", commit])
os.makedirs(out)
files = []
with tarfile.open(fileobj=io.BytesIO(tar)) as t:
    for m in t.getmembers():
        if m.isdir():
            os.makedirs(os.path.join(out, m.name), exist_ok=True)
        elif m.isfile():
            data = t.extractfile(m).read()
            p = os.path.join(out, m.name)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
            files.append({"path": m.name, "sha256": hashlib.sha256(data).hexdigest()})
        else:
            sys.exit(f"unsupported tar member {m.name}")
files.sort(key=lambda f: f["path"])
manifest = json.dumps({"files": files, "generation_id": commit,
    "schema": "WatchdogGenerationManifestV1", "source_commit": commit}, indent=2, sort_keys=True) + "\n"
with open(os.path.join(out, "generation.json"), "w") as f:
    f.write(manifest)
with open(os.path.join(out, "generation.sha256"), "w") as f:
    f.write(hashlib.sha256(manifest.encode()).hexdigest() + "\n")
for root, dirs, names in os.walk(out, topdown=False):
    for n in names:
        os.chmod(os.path.join(root, n), 0o444)
    for d in dirs:
        os.chmod(os.path.join(root, d), 0o555)
os.chmod(out, 0o555)
print(commit, len(files))
