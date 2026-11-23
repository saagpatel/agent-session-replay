/** A legacy session ID needs a framed header. An exit can also occur without a body. */
export function legacyShellHeader(output: string) {
	const prefix = output.slice(0, 400);
	const boundary = prefix.search(/^(?:Final output|Output):/m);
	const header = boundary < 0 ? prefix : prefix.slice(0, boundary);
	return {
		sessionId: boundary < 0 ? null : /^Process running with session ID ([\w-]+)[ \t]*\r?$/m.exec(header)?.[1] ?? null,
		exits: Array.from(header.matchAll(/^Process exited with code (\d+)[ \t]*\r?$/gm), match => Number(match[1])),
	};
}
