import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const repoRoot = new URL("../", import.meta.url);

function readRepoFile(path: string): string {
	return readFileSync(new URL(path, repoRoot), "utf8");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvedLockVersions(lockfile: string, packageName: string): string[] {
	const pattern = new RegExp(
		`^\\s{2}${escapeRegex(packageName)}@([^:\\s(]+)`,
		"gm",
	);
	return [...new Set([...lockfile.matchAll(pattern)].map((match) => match[1]))];
}

function compareSemver(current: string, minimum: string): number {
	const currentParts = current.split(".").map((part) => Number(part));
	const minimumParts = minimum.split(".").map((part) => Number(part));
	for (let index = 0; index < 3; index += 1) {
		const delta = (currentParts[index] ?? 0) - (minimumParts[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function assertAllResolvedAtLeast(
	lockfile: string,
	packageName: string,
	minimum: string,
): void {
	const versions = resolvedLockVersions(lockfile, packageName);
	assert.notEqual(
		versions.length,
		0,
		`expected ${packageName} to be resolved in pnpm-lock.yaml`,
	);
	for (const version of versions) {
		assert.ok(
			compareSemver(version, minimum) >= 0,
			`${packageName}@${version} must be >= ${minimum}`,
		);
	}
}

test("security-sensitive build dependencies stay above Dependabot advisory ranges", () => {
	const packageJson = JSON.parse(readRepoFile("package.json")) as {
		devDependencies: Record<string, string>;
	};
	const lockfile = readRepoFile("pnpm-lock.yaml");

	assert.equal(packageJson.devDependencies.vite, "^8.2.2");
	assertAllResolvedAtLeast(lockfile, "vite", "8.2.2");
	assertAllResolvedAtLeast(lockfile, "postcss", "8.5.23");
	assertAllResolvedAtLeast(lockfile, "nanoid", "3.3.18");
});
