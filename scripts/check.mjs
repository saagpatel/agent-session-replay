import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync(new URL("../node_modules", import.meta.url))) {
	console.error("Dependencies are missing. Run `pnpm install --frozen-lockfile` first.");
	process.exit(1);
}

for (const script of ["typecheck", "test", "build", "render:smoke"]) {
	console.log(`\n> pnpm ${script}`);
	const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	const result = spawnSync(command, ["run", script], { stdio: "inherit" });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}
