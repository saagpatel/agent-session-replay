import { createServer } from "vite";

const server = await createServer({
	root: process.cwd(),
	logLevel: "error",
	server: { middlewareMode: true },
	optimizeDeps: { noDiscovery: true },
	appType: "custom",
});
try {
	await server.ssrLoadModule("/scripts/render-smoke.tsx");
} finally {
	await server.close();
}
