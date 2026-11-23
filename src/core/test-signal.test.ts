import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTestPasses } from "./test-signal.ts";

test("quiet pytest accepts a positive pass count alongside skipped tests", () => {
	assert.equal(hasTestPasses("2 passed, 1 skipped in 0.12s"), true);
	assert.equal(hasTestPasses("1 skipped, 2 passed in 0.12s"), true);
	assert.equal(hasTestPasses("1 skipped in 0.12s"), false);
	assert.equal(hasTestPasses("0 passed, 1 skipped in 0.12s"), false);
	assert.equal(hasTestPasses("2 passed, 1 skipped, 1 failed in 0.12s"), false);
});

test("unittest accepts a completed run with a skipped count", () => {
	assert.equal(hasTestPasses("Ran 2 tests in 0.010s\n\nOK (skipped=1)"), true);
	assert.equal(hasTestPasses("Ran 0 tests in 0.010s\n\nOK (skipped=1)"), false);
	assert.equal(hasTestPasses("OK (skipped=1)"), false);
});
