import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateReplayFixtures } from "../src/core/export/fixtures/generate.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (args.length !== 0 && (args.length !== 2 || outIndex !== 0 || !args[1])) {
	throw new Error("Usage: pnpm gen:replay-fixtures --out <dir>");
}

const root = resolve(args[1] ?? "fixtures/generated");
const sessionDir = resolve(root, "replay-sessions");
const misleadingDir = resolve(root, "misleading-edits");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(misleadingDir, { recursive: true });
const save = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const generated = generateReplayFixtures();

for (const { slug, trace, faithful } of generated.sessions) {
	save(resolve(sessionDir, `${slug}.trace.json`), trace);
	save(resolve(sessionDir, `${slug}.faithful.manifest.json`), faithful);
}
for (const { slug, kind, manifest, expect } of generated.misleading) {
	save(resolve(misleadingDir, `${slug}.${kind}.manifest.json`), { ...manifest, expect });
}
