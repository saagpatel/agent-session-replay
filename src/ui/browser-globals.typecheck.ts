// This browser-only compile fixture guards the ambient type boundary.
// @ts-expect-error Node globals must not be available to browser code.
void process;
