# `@repo/api`

The backend for Scatter Gather Agent Viewer: a [Bun](https://bun.sh) process running
[Elysia](https://elysiajs.com) with an [oRPC](https://orpc.unnoq.com) router.
Every AWS API call in the system is made here; the web app has no AWS SDK
dependency and reaches everything over `/rpc`.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /health` | ALB health check |
| `GET /auth/verify` | `forward_auth` target for the Durable Streams server; 204 when the request carries a valid session cookie, 401 otherwise |
| `/api/auth/*` | Better Auth (Cognito sign-in, session management) |
| `/rpc/*` | oRPC procedures, see `src/orpc/router/index.ts` for the tree |

All procedures are built on `src/orpc/base.ts`, which rejects any call
without a Better Auth session. The HTTP layer (`src/index.ts`) resolves the
session from the cookie and passes it in as oRPC context.

## Layout

```
src/index.ts                  Elysia app, CORS, session resolution
src/orpc/base.ts              Auth guard + error shaping shared by every procedure
src/orpc/router/
  journeys.ts                 Journey CRUD, bucket/path pickers, bucket readiness
  journey-agents.ts           Assign/validate/fix agent runtimes for a journey
  assessments.ts              Start and read scatter-gather runs
  agents.ts                   List/inspect AgentCore runtimes in the account
  metrics.ts                  CloudWatch-backed dashboard figures
src/lib/run-assessment.ts     The scatter-gather orchestration
src/lib/assessment-streams.ts Live output to Durable Streams
src/lib/s3files.ts            Amazon S3 Files provisioning per journey
src/lib/agent-permissions.ts  IAM validation and quick-fix for agent roles
src/lib/journey-bucket.ts     S3 bucket checks (versioning, encryption)
```

## Configuration

See [`.env.example`](.env.example). `bun run setup` at the repository root
fills in `.env` from the deployed stack. In ECS the same values arrive as
container environment variables and Secrets Manager-backed secrets
(`apps/infra/lib/construct/api.ts`).

## Develop

```sh
bun run dev        # bun --watch src/index.ts on http://localhost:4000
```

The production image (`Dockerfile`) compiles the app to a single binary with
`bun build --compile` and runs it on a distroless base.
