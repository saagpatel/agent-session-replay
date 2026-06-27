import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local-first SPA: no backend, no telemetry. The transcript is parsed and
// rendered entirely in the browser; nothing is ever uploaded.
export default defineConfig({
	plugins: [react()],
	build: { outDir: "dist", target: "es2022" },
});
