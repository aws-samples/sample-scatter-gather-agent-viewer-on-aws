import http from "node:http";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

/** Forwards /sync/* to the local Durable Streams server, streaming both ways (SSE). */
function streamsDevProxy(target: string): Plugin {
	const targetUrl = new URL(target);
	return {
		name: "streams-dev-proxy",
		apply: "serve",
		configureServer(server) {
			// Registered without returning a post-hook so it runs before the
			// SSR catch-all.
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith("/sync/")) {
					return next();
				}
				const proxyReq = http.request(
					new URL(req.url, targetUrl),
					{
						method: req.method,
						headers: { ...req.headers, host: targetUrl.host },
					},
					(proxyRes) => {
						res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
						proxyRes.pipe(res);
					},
				);
				proxyReq.on("error", () => {
					res.statusCode = 502;
					res.end(
						"durable-streams dev proxy: upstream unavailable (bun run db:up)",
					);
				});
				req.pipe(proxyReq);
			});
		},
	};
}

export default defineConfig({
	resolve: { tsconfigPaths: true },
	server: {
		port: 3000,
	},
	plugins: [
		// Live assessment streams. Mirrors the ALB in production, which routes
		// /sync/* to the Durable Streams service; locally that is the
		// docker-compose `durable-streams` container. Same-origin so the Better
		// Auth session cookie accompanies stream reads. A plugin middleware
		// rather than `server.proxy` because TanStack Start's SSR handler
		// answers before the built-in proxy ever sees the request.
		streamsDevProxy(
			process.env.VITE_STREAMS_PROXY_TARGET ?? "http://localhost:4437",
		),
		// https://tanstack.com/devtools/latest/docs/quick-start#vite-plugin
		devtools(),
		// https://tanstack.com/start/v0/docs/framework/react/guide/hosting#bun
		nitro({ preset: "bun" }),
		// https://tailwindcss.com/docs/installation/using-vite
		tailwindcss(),
		tanstackStart(),
		// react's vite plugin must come after start's vite plugin
		viteReact(),
	],
});
