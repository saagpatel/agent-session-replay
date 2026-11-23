/**
 * Read a test runner's own summary lines out of a tool's output.
 *
 * Exit codes are not enough: agents often pipe test output (`npm test | head`),
 * which exits with the last command's status. Parsers record what the summary
 * says in the open attribute bag (`ATTR.TEST_FAILURES`, `ATTR.TEST_PASSES`), so
 * consumers can tell a green exit code from a green test run.
 *
 * Patterns are anchored to summary lines, so a passing test named
 * "marks 2 failed uploads as retryable" or a log line "1 failed attempt" never
 * reads as a failure.
 */

const PYTEST_COUNT = String.raw`\d+ (?:failed|errors?|passed|skipped|xfailed|xpassed|deselected|warnings?)`;
const UNITTEST_COUNT = String.raw`(?:failures|errors|skipped|expected failures|unexpected successes)=\d+`;
const FAIL_PATTERNS: readonly RegExp[] = [
	/^[ \t]*ℹ fail [1-9]/m, // node --test
	/^# fail [1-9]/m, // node --test (TAP)
	/^=+ .*\b[1-9]\d* (?:failed|errors?)\b.*=+[ \t]*$/m, // pytest
	// pytest -q: one positive failure or error count anywhere in the outcome list.
	new RegExp(String.raw`^(?=[^\r\n]*\b[1-9]\d* (?:failed|errors?)\b)[ \t]*${PYTEST_COUNT}(?:, ${PYTEST_COUNT})* in \d+(?:\.\d+)?s[ \t]*$`, "m"),
	new RegExp(String.raw`^Ran \d+ tests? in \d+(?:\.\d+)?s\r?\n(?:\r?\n)?FAILED \((?:${UNITTEST_COUNT}, )*(?:failures|errors|unexpected successes)=[1-9]\d*(?:, ${UNITTEST_COUNT})*\)[ \t]*$`, "m"),
	/^[ \t]*Tests?[ \t]+.*\b[1-9]\d* failed\b/m, // vitest
	/^Tests:[ \t]+[1-9]\d* failed/m, // jest
	/^[ \t]*[1-9]\d* failing[ \t]*$/m, // mocha
	/^test result: FAILED/m, // cargo
	/^not ok\b/m, // TAP
	/^--- FAIL:/m, // go
	/^FAIL(?:[ \t]|$)/m, // go package / jest file summary
];

const PASS_PATTERNS: readonly RegExp[] = [
	/^[ \t]*ℹ fail 0[ \t]*$/m, // node --test
	/^# fail 0[ \t]*$/m, // node --test (TAP)
	/^=+ .*\b\d+ passed\b.*=+[ \t]*$/m, // pytest
	new RegExp(String.raw`^(?=[^\r\n]*\b[1-9]\d* passed\b)[ \t]*${PYTEST_COUNT}(?:, ${PYTEST_COUNT})* in \d+(?:\.\d+)?s[ \t]*$`, "m"), // pytest -q
	/^Ran [1-9]\d* tests? in \d+(?:\.\d+)?s\r?\n(?:\r?\n)?OK(?: \(skipped=\d+\))?[ \t]*$/m, // unittest
	/^[ \t]*Tests?[ \t]+\d+ passed\b/m, // vitest
	/^Tests:[ \t]+\d+ passed, \d+ total/m, // jest
	/^[ \t]*\d+ passing\b/m, // mocha
	/^test result: ok\./m, // cargo
	/^ok[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\))[ \t]*$/m, // go: `ok  pkg 0.01s`, never TAP's `ok 1 - name`
	/^PASS[ \t]*$/m, // go
];

/** Codex exec cells nest output as JSON strings, leaving newlines escaped. */
function unescape(text: string): string {
	return text.replace(/\\n/g, "\n");
}

/** True when a test runner's summary reports failures. */
export function hasTestFailures(text: string): boolean {
	const t = unescape(text);
	return FAIL_PATTERNS.some((re) => re.test(t));
}

/** True when a test runner's summary reports success and nothing reports failure. */
export function hasTestPasses(text: string): boolean {
	const t = unescape(text);
	return !hasTestFailures(t) && PASS_PATTERNS.some((re) => re.test(t));
}
