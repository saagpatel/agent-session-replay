import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTestFailures, hasTestPasses } from "./test-signal.ts";

test("quiet pytest accepts a positive pass count alongside skipped tests", () => {
	assert.equal(hasTestPasses("2 passed, 1 skipped in 0.12s"), true);
	assert.equal(hasTestPasses("1 skipped, 2 passed in 0.12s"), true);
	assert.equal(hasTestPasses("1 skipped in 0.12s"), false);
	assert.equal(hasTestPasses("0 passed, 1 skipped in 0.12s"), false);
	assert.equal(hasTestPasses("2 passed, 1 skipped, 1 failed in 0.12s"), false);
});

test("unittest accepts successful summaries with skipped and expected failure counts", () => {
	assert.equal(hasTestPasses("Ran 2 tests in 0.010s\n\nOK (skipped=1)"), true);
	assert.equal(hasTestPasses("Ran 2 tests in 0.010s\n\nOK (expected failures=1)"), true);
	assert.equal(hasTestPasses("Ran 3 tests in 0.010s\n\nOK (skipped=1, expected failures=1)"), true);
	assert.equal(hasTestPasses("Ran 3 tests in 0.010s\n\nOK (skipped=1, failures=1)"), false);
	assert.equal(hasTestPasses("Ran 0 tests in 0.010s\n\nOK (skipped=1)"), false);
	assert.equal(hasTestPasses("OK (skipped=1)"), false);
});

test("unittest detects a positive failure or error among multiple counts", () => {
	const summary = (counts: string) => `Ran 4 tests in 0.010s\n\nFAILED (${counts})`;
	assert.equal(hasTestFailures(summary("failures=1, skipped=1")), true);
	assert.equal(hasTestFailures(summary("errors=1, skipped=1, expected failures=2")), true);
	assert.equal(hasTestFailures(summary("failures=0, skipped=1, expected failures=2")), false);
	assert.equal(hasTestFailures("FAILED (failures=1, skipped=1)"), false);
});
