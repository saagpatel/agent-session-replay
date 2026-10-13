import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("build-watchdog-release.py")
SPEC = importlib.util.spec_from_file_location("build_watchdog_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


COMMIT = "a" * 40


def archive_bytes() -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        data = b"watchdog source\n"
        member = tarfile.TarInfo("scripts/watchdog.py")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class BuildWatchdogReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.parent = Path(self.tempdir.name) / "releases"
        self.out = self.parent / COMMIT

    def git_output(self, args, **kwargs):
        if args[3] == "rev-parse":
            return COMMIT + "\n"
        if args[3] == "archive":
            return archive_bytes()
        self.fail(f"unexpected git command: {args}")

    def assert_no_partial_generation(self):
        self.assertFalse(self.out.exists())
        if self.parent.exists():
            self.assertEqual(list(self.parent.iterdir()), [])

    def test_archive_command_failure_leaves_no_output_or_staging(self):
        def fail_archive(args, **kwargs):
            if args[3] == "rev-parse":
                return COMMIT + "\n"
            raise RuntimeError("injected archive failure")

        with self.assertRaisesRegex(RuntimeError, "injected archive failure"):
            release.build_release("repo", "HEAD", str(self.out), check_output=fail_archive)
        self.assert_no_partial_generation()

    def test_extraction_failure_removes_staging(self):
        with mock.patch.object(release, "_extract_archive", side_effect=RuntimeError("injected extraction failure")):
            with self.assertRaisesRegex(RuntimeError, "injected extraction failure"):
                release.build_release("repo", "HEAD", str(self.out), check_output=self.git_output)
        self.assert_no_partial_generation()

    def test_validation_failure_removes_staging(self):
        with mock.patch.object(release, "_validate_generation", side_effect=RuntimeError("injected validation failure")):
            with self.assertRaisesRegex(RuntimeError, "injected validation failure"):
                release.build_release("repo", "HEAD", str(self.out), check_output=self.git_output)
        self.assert_no_partial_generation()

    def test_publish_failure_removes_staging(self):
        with mock.patch.object(release, "_publish", side_effect=RuntimeError("injected publish failure")):
            with self.assertRaisesRegex(RuntimeError, "injected publish failure"):
                release.build_release("repo", "HEAD", str(self.out), check_output=self.git_output)
        self.assert_no_partial_generation()

    def test_success_publishes_validated_read_only_generation(self):
        commit, count = release.build_release("repo", "HEAD", str(self.out), check_output=self.git_output)
        self.assertEqual((commit, count), (COMMIT, 1))
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), ["generation.json", "generation.sha256", "scripts"])
        self.assertEqual((self.out / "scripts" / "watchdog.py").read_bytes(), b"watchdog source\n")
        self.assertEqual(os.stat(self.out).st_mode & 0o777, 0o555)
        self.assertEqual(list(self.parent.iterdir()), [self.out])


if __name__ == "__main__":
    unittest.main()
