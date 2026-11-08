/**
 * Spot a failing test run in a tool's output text.
 *
 * Exit codes are not enough: agents often pipe test output (`npm test | head`),
 * which reports success even when tests fail. Parsers record this signal in the
 * open attribute bag (`ATTR.TEST_FAILURES`) so consumers can tell a green exit
 * code from a green test run.
 */

const FAIL_PATTERNS: readonly RegExp[] = [
	/ℹ fail [1-9]/, // node --test
	/# fail [1-9]/, // node --test (TAP)
	/\b[1-9]\d* (?:failed|failing)\b/, // pytest, vitest, mocha
	/Tests:\s+[1-9]\d* failed/, // jest
	/test result: FAILED/, // cargo
	/(?:^|\n)--- FAIL:/, // go
	/(?:^|\n)FAIL\s/, // go / jest file summary
];

/** True when the text reads like a test run with failures. */
export function hasTestFailures(text: string): boolean {
	// Codex exec cells nest output as JSON strings, leaving newlines escaped.
	const t = text.replace(/\\n/g, "\n");
	return FAIL_PATTERNS.some((re) => re.test(t));
}
