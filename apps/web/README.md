# `@repo/web`

The Scatter Gather Agent Viewer console: a [TanStack Start](https://tanstack.com/start)
application (React 19, Vite, file-based TanStack Router) styled with Tailwind
CSS and shadcn/ui components.

## Routes

| Route | Purpose |
|---|---|
| `/login` | Cognito sign-in via Better Auth |
| `/` | Dashboard of AgentCore and Bedrock usage metrics |
| `/agents`, `/agents/$agentId` | Browse the AgentCore runtimes in the account |
| `/journeys`, `/journeys/new` | List and create journeys |
| `/journeys/$journeyId` | Assigned agents, assessments, and the "Start assessment" wizard |
| `/journeys/$journeyId/assessments/$assessmentId` | Live per-agent streams while running; rendered report when complete |

Routes under `src/routes/_protected/` call `auth.api.getSession` on the
server in `beforeLoad` and redirect to `/login` without a session.

## Talking to the API

`src/orpc/client.ts` creates a typed oRPC client from the API's router type
(`@repo/api/router`). In the browser it calls `${VITE_API_URL}/rpc` with
credentials; during SSR it calls the API service directly and forwards the
incoming request headers so the session cookie travels with it. Live
assessment output is read from `/sync/*` with `@durable-streams/client`; the
Vite dev server proxies that path to the local Durable Streams container
(`vite.config.ts`).

## Configuration

See [`.env.example`](.env.example). `bun run setup` at the repository root
fills in `.env` from the deployed stack.

## Develop

```sh
bun run dev          # http://localhost:3000
bun run build        # vite build -> .output (Nitro, bun preset)
bun run start        # serve the production build
bun run lint         # biome check --write
bun run check-types  # tsc --noEmit
```

Components under `src/components/ui` are generated with the shadcn CLI
(`components.json`). Third-party component sources and their licenses are
listed in the repository's `THIRD-PARTY-LICENSES`.
