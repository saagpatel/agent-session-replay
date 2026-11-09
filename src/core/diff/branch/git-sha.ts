/** Pure TypeScript helpers for Git's SHA-1 object format. */

const encoder = new TextEncoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha1(input: Uint8Array): Uint8Array {
	const bitLength = input.length * 8;
	const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const words = new Uint32Array(80);
	for (let block = 0; block < paddedLength; block += 64) {
		for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4, false);
		for (let i = 16; i < 80; i++) words[i] = rotateLeft(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const next = (rotateLeft(a, 5) + f + e + k + words[i]!) >>> 0;
			e = d;
			d = c;
			c = rotateLeft(b, 30);
			b = a;
			a = next;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	const output = new Uint8Array(20);
	const outputView = new DataView(output.buffer);
	[h0, h1, h2, h3, h4].forEach((word, index) => outputView.setUint32(index * 4, word, false));
	return output;
}

function rotateLeft(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function objectHash(type: string, content: Uint8Array): Uint8Array {
	return sha1(concatBytes(encoder.encode(`${type} ${content.length}\0`), content));
}

export type FixtureRepoCommit = {
	parent: string | null;
	message: string;
	files: Record<string, string>;
};

type TreeEntries = Map<string, string | TreeEntries>;

function gitPathParts(files: Record<string, string>): TreeEntries {
	const root: TreeEntries = new Map();
	for (const [path, content] of Object.entries(files)) {
		const parts = path.split("/");
		if (!path || parts.some((part) => !part || part === "." || part === "..")) {
			throw new Error(`Invalid fixture path: ${path}`);
		}
		let directory = root;
		for (const part of parts.slice(0, -1)) {
			const existing = directory.get(part);
			if (existing instanceof Map) directory = existing;
			else if (existing !== undefined) throw new Error(`Fixture path is both file and directory: ${path}`);
			else {
				const nested: TreeEntries = new Map();
				directory.set(part, nested);
				directory = nested;
			}
		}
		const filename = parts.at(-1)!;
		if (directory.has(filename)) throw new Error(`Duplicate fixture path: ${path}`);
		directory.set(filename, content);
	}
	return root;
}

function treeHash(entries: TreeEntries): Uint8Array {
	const records = [...entries.entries()].map(([name, value]) => ({
		name,
		isDirectory: value instanceof Map,
		mode: value instanceof Map ? "40000" : "100644",
		hash: value instanceof Map ? treeHash(value) : objectHash("blob", encoder.encode(value)),
	}));
	// Git compares a directory as if its name had a trailing slash.
	records.sort((left, right) => compareBytes(
		encoder.encode(left.name + (left.isDirectory ? "/" : "")),
		encoder.encode(right.name + (right.isDirectory ? "/" : "")),
	));
	const serialized = records.map(({ mode, name, hash }) => concatBytes(encoder.encode(`${mode} ${name}\0`), hash));
	return objectHash("tree", concatBytes(...serialized));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const limit = Math.min(left.length, right.length);
	for (let i = 0; i < limit; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
	return left.length - right.length;
}

export function gitBlobSha(content: string): string {
	return hex(objectHash("blob", encoder.encode(content)));
}

export function gitTreeSha(files: Record<string, string>): string {
	return hex(treeHash(gitPathParts(files)));
}

export function gitCommitSha(commit: FixtureRepoCommit): string {
	const tree = gitTreeSha(commit.files);
	const parentLine = commit.parent === null ? "" : `parent ${commit.parent}\n`;
	if (commit.parent !== null && !/^[0-9a-f]{40}$/.test(commit.parent)) {
		throw new Error(`Invalid parent SHA: ${commit.parent}`);
	}
	const content = `tree ${tree}\n${parentLine}author Fixture <fixture@example.invalid> 1767225600 +0000\ncommitter Fixture <fixture@example.invalid> 1767225600 +0000\n\n${commit.message.replace(/\n*$/, "")}\n`;
	return hex(objectHash("commit", encoder.encode(content)));
}

export function fixtureRepoCommitShas(commits: FixtureRepoCommit[]): string[] {
	let previous: string | null = null;
	return commits.map((commit, index) => {
		if (index === 0 && commit.parent !== null) throw new Error("First fixture commit must have a null parent");
		if (index > 0 && commit.parent !== previous) throw new Error(`Commit ${index} parent does not match the prior commit`);
		previous = gitCommitSha(commit);
		return previous;
	});
}
