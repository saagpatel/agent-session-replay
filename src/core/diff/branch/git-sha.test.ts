import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fixtureRepoCommitShas, gitBlobSha, gitTreeSha, type FixtureRepoCommit } from "./git-sha.ts";

function isolatedGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
		delete env[key];
	}
	return env;
}

test("git blob hashes use exact Git object serialization", () => {
	assert.equal(gitBlobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	assert.equal(gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("nested and UTF-8 paths use Git tree sort order", (context) => {
	const git = spawnSync("git", ["--version"], { encoding: "utf8" });
	if (git.error instanceof Error && "code" in git.error && git.error.code === "ENOENT") {
		context.skip("git is absent; tree ordering comparison requires the Git CLI");
		return;
	}
	const files = {
		"src/a/a.txt": "nested\n",
		"src/ä.txt": "unicode\n",
		"src/a-more.txt": "prefix sibling\n",
		"src/z.txt": "last\n",
	};
	const scratchRoot = resolve(".tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const root = mkdtempSync(join(scratchRoot, "branch-tree-sha-"));
	try {
		const env = isolatedGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
		const runGit = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
			assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
			return result.stdout.trim();
		};
		runGit("init", "--quiet", "--initial-branch=main");
		for (const [path, content] of Object.entries(files)) {
			const destination = join(root, path);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, content);
		}
		runGit("add", "--all");
		assert.equal(gitTreeSha(files), runGit("write-tree"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture repository commit hashes match the Git CLI", (context) => {
	const git = spawnSync("git", ["--version"], { encoding: "utf8" });
	if (git.error instanceof Error && "code" in git.error && git.error.code === "ENOENT") {
		context.skip("git is absent; fixture commit materialization requires the Git CLI");
		return;
	}
	assert.equal(git.status, 0, `git --version failed: ${git.stderr}`);
	const reposDirectory = resolve("fixtures/run-diff/branch/repos");
	const repoFiles = readdirSync(reposDirectory).filter((name) => name.endsWith(".json")).sort();
	assert.ok(repoFiles.length > 0, "expected fixture repository JSON files");
	const scratchRoot = resolve(".tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = mkdtempSync(join(scratchRoot, "branch-git-sha-"));
	try {
		for (const repoFile of repoFiles) {
			const repo = JSON.parse(readFileSync(join(reposDirectory, repoFile), "utf8")) as { commits: FixtureRepoCommit[] };
			const expected = fixtureRepoCommitShas(repo.commits);
			const root = join(scratch, repoFile.slice(0, -5));
			mkdirSync(root);
			const env = isolatedGitEnv({
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
				GIT_AUTHOR_DATE: "1767225600 +0000",
				GIT_COMMITTER_DATE: "1767225600 +0000",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			});
			const runGit = (...args: string[]) => {
				const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
				assert.equal(result.status, 0, `${repoFile}: git ${args.join(" ")} failed: ${result.stderr}`);
				return result.stdout.trim();
			};
			runGit("init", "--quiet", "--initial-branch=main");
			runGit("config", "commit.gpgsign", "false");
			for (let index = 0; index < repo.commits.length; index++) {
				const commit = repo.commits[index]!;
				for (const [path, content] of Object.entries(commit.files)) {
					const destination = join(root, path);
					mkdirSync(dirname(destination), { recursive: true });
					writeFileSync(destination, content);
				}
				// Remove tracked files omitted from the next declared full tree.
				if (index > 0) {
					const tracked = runGit("ls-files").split("\n").filter(Boolean);
					for (const path of tracked) if (!(path in commit.files)) rmSync(join(root, path), { force: true });
				}
				runGit("add", "--all");
				runGit("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", commit.message);
				assert.equal(runGit("rev-parse", "HEAD"), expected[index], `${repoFile} commit ${index + 1}`);
			}
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
