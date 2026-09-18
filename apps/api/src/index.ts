import { cors } from "@elysia/cors";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { auth } from "@repo/auth";
import { Elysia } from "elysia";

import type { RpcContext } from "@/orpc/base";
import router from "@/orpc/router";

const handler = new RPCHandler(router, {
	interceptors: [
		onError((error) => {
			console.error(error);
		}),
	],
});

const app = new Elysia()
	.use(
		cors({
			// Same-origin in production (routed via CloudFront -> ALB), so this
			// mainly covers the local dev server on :3000.
			origin: (process.env.TRUSTED_ORIGINS ?? "http://localhost:3000")
				.split(",")
				.map((origin) => origin.trim())
				.filter(Boolean),
			credentials: true,
		}),
	)
	.get("/health", () => "ok")
	// forward_auth target for the Durable Streams server: browser reads of
	// /sync/* are admitted only if this returns 2xx for the request's session
	// cookie. Caddy forwards the original query string, so only the path is
	// matched. See apps/streams/Caddyfile.
	.get("/auth/verify", async ({ request }: { request: Request }) => {
		const session = await auth.api.getSession({ headers: request.headers });
		return new Response(null, { status: session ? 204 : 401 });
	})
	.mount(auth.handler)
	.all(
		"/rpc*",
		async ({ request }: { request: Request }) => {
			// Resolve the Better Auth session from the request cookie and hand it
			// to oRPC as context. The `base` procedure builder rejects any call
			// without a session, so every procedure is authenticated.
			const session = await auth.api.getSession({ headers: request.headers });
			const context: RpcContext = { session };

			const { response } = await handler.handle(request, {
				prefix: "/rpc",
				context,
			});

			return response ?? new Response("Not found", { status: 404 });
		},
		{
			parse: "none", // Skip Elysia's body parsing; oRPC reads the raw request itself
		},
	)
	.listen(process.env.PORT ?? 4000);

console.log(`API listening at ${app.server?.hostname}:${app.server?.port}`);
