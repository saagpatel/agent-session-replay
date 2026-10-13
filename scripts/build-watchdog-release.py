#!/usr/bin/env python3
"""Export a git commit as an immutable watchdog release directory.

Usage: build-watchdog-release.py <repo> <commit> <out-dir>
Out-dir is normally a private, operator-managed release directory.
Output matches the WatchdogGenerationManifestV1 layout byte for byte.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Callable


def _safe_archive_path(name: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"unsafe tar member path {name!r}")
    return os.path.join(*path.parts)


def _extract_archive(archive: bytes, destination: str) -> list[dict[str, str]]:
    """Extract regular files and directories while rejecting special entries."""
    files: list[dict[str, str]] = []
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar.getmembers():
            relative_path = _safe_archive_path(member.name)
            path = os.path.join(destination, relative_path)
            if member.isdir():
                os.makedirs(path, exist_ok=True)
            elif member.isfile():
                data_stream = tar.extractfile(member)
                if data_stream is None:
                    raise ValueError(f"could not read tar member {member.name}")
                data = data_stream.read()
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as output:
                    output.write(data)
                files.append({"path": member.name, "sha256": hashlib.sha256(data).hexdigest()})
            else:
                raise ValueError(f"unsupported tar member {member.name}")
    files.sort(key=lambda file: file["path"])
    return files


def _write_manifests(destination: str, commit: str, files: list[dict[str, str]]) -> bytes:
    manifest = json.dumps(
        {
            "files": files,
            "generation_id": commit,
            "schema": "WatchdogGenerationManifestV1",
            "source_commit": commit,
        },
        indent=2,
        sort_keys=True,
    ) + "\n"
    manifest_bytes = manifest.encode()
    with open(os.path.join(destination, "generation.json"), "wb") as output:
        output.write(manifest_bytes)
    with open(os.path.join(destination, "generation.sha256"), "w", encoding="ascii") as output:
        output.write(hashlib.sha256(manifest_bytes).hexdigest() + "\n")
    return manifest_bytes


def _validate_generation(destination: str, commit: str, expected_files: list[dict[str, str]]) -> None:
    manifest_path = os.path.join(destination, "generation.json")
    digest_path = os.path.join(destination, "generation.sha256")
    with open(manifest_path, "rb") as source:
        manifest_bytes = source.read()
    with open(digest_path, "r", encoding="ascii") as source:
        digest = source.read()
    if digest != hashlib.sha256(manifest_bytes).hexdigest() + "\n":
        raise ValueError("generation manifest digest does not match")

    manifest = json.loads(manifest_bytes)
    if manifest != {
        "files": expected_files,
        "generation_id": commit,
        "schema": "WatchdogGenerationManifestV1",
        "source_commit": commit,
    }:
        raise ValueError("generation manifest content does not match extracted files")

    expected_paths = {file["path"]: file["sha256"] for file in expected_files}
    found_paths: set[str] = set()
    for root, directories, names in os.walk(destination):
        directories.sort()
        for name in names:
            path = os.path.join(root, name)
            relative = os.path.relpath(path, destination).replace(os.sep, "/")
            if relative in ("generation.json", "generation.sha256"):
                continue
            with open(path, "rb") as source:
                actual_digest = hashlib.sha256(source.read()).hexdigest()
            if expected_paths.get(relative) != actual_digest:
                raise ValueError(f"release file validation failed for {relative}")
            found_paths.add(relative)
    if found_paths != set(expected_paths):
        raise ValueError("release is missing one or more archived files")


def _make_read_only(destination: str) -> None:
    for root, directories, names in os.walk(destination, topdown=False):
        for name in names:
            os.chmod(os.path.join(root, name), 0o444)
        for name in directories:
            os.chmod(os.path.join(root, name), 0o555)
    os.chmod(destination, 0o555)


def _remove_staging(destination: str) -> None:
    if not os.path.exists(destination):
        return
    for root, directories, _ in os.walk(destination):
        os.chmod(root, 0o755)
        for directory in directories:
            os.chmod(os.path.join(root, directory), 0o755)
    shutil.rmtree(destination)


def _publish(staging: str, destination: str) -> None:
    os.rename(staging, destination)


def build_release(
    repo: str,
    commit: str,
    out: str,
    *,
    check_output: Callable[..., bytes] = subprocess.check_output,
) -> tuple[str, int]:
    commit = check_output(
        ["git", "-C", repo, "rev-parse", commit + "^{commit}"], text=True
    ).strip()
    out = os.path.abspath(out)
    if os.path.lexists(out):
        raise FileExistsError(f"refusing: {out} exists")

    archive = check_output(["git", "-C", repo, "archive", "--format=tar", commit])
    parent = os.path.dirname(out)
    os.makedirs(parent, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=f".{os.path.basename(out)}.staging-", dir=parent)
    try:
        files = _extract_archive(archive, staging)
        _write_manifests(staging, commit, files)
        _validate_generation(staging, commit, files)
        _make_read_only(staging)
        # Check again immediately before publication so a pre-existing target is
        # never intentionally replaced. The sibling rename publishes a complete
        # generation in one filesystem operation.
        if os.path.lexists(out):
            raise FileExistsError(f"refusing: {out} exists")
        _publish(staging, out)
    except BaseException:
        _remove_staging(staging)
        raise
    return commit, len(files)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("Usage: build-watchdog-release.py <repo> <commit> <out-dir>", file=sys.stderr)
        return 2
    try:
        commit, count = build_release(argv[1], argv[2], argv[3])
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    print(commit, count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
