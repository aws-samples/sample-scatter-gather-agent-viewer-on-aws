# Scatter Gather Agent Viewer on AWS

A sample web console that runs **scatter-gather migration assessments** with
[Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) agents.
You point it at migration data in an Amazon S3 bucket, assign one or more
AgentCore agent runtimes to it, and launch a run. Every agent scans the data in
parallel (*scatter*) and a built-in aggregator agent merges their findings into
a single consolidated report (*gather*). Agent output streams live to the
browser while the run is in progress.

> **This is sample code.** It exists to demonstrate an architecture and is not
> intended for production use. Review the [Security](#security) section before
> deploying it into any account that holds real data.

## How it works

```
                 ┌──────────────────────────────────────────────────────────┐
  Browser ──────▶│ CloudFront ─▶ ALB ─▶ web (TanStack Start)                │
                 │                  ├─▶ api (Elysia + oRPC) ─▶ Aurora       │
                 │                  └─▶ streams (Durable Streams)           │
                 └──────────────┬───────────────────────────────────────────┘
                                │ InvokeAgentRuntime (scatter, in parallel)
                 ┌──────────────▼───────────────┐   ┌──────────────────────┐
                 │ Agent runtime A  ─┐          │   │ S3 Files mounts      │
                 │ Agent runtime B  ─┼─ reports ┼──▶│ /mnt/source          │
                 │ Agent runtime C  ─┘   to S3  │   │ /mnt/target          │
                 └──────────────┬───────────────┘   └──────────────────────┘
                                │ InvokeHarness (gather)
                 ┌──────────────▼───────────────┐
                 │ Aggregator harness           │──▶ consolidated Markdown
                 │  tools: get_report, run_sql, │    report stored on the
                 │  list/invoke_sub_agent (MCP) │    assessment row
                 └──────────────────────────────┘
```

1. **Journey.** A journey names a migration and binds it to an S3 bucket plus a
   source path (and optional target path). Creating one provisions an
   [Amazon S3 Files](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html)
   file system, read-only access points for each path, and mount targets in
   the stack's private subnets, so agents can read the data as a POSIX file
   system.
2. **Agents.** Agents are AgentCore agent runtimes that already exist in your
   account; the sample does not create them. A three-step wizard assigns
   runtimes to a journey, validates that each one runs in the VPC, has the
   journey's mounts attached at `/mnt/source` and `/mnt/target`, and has an
   execution role that can mount and read, and offers one-click fixes for each
   check.
3. **Assessment.** Starting an assessment invokes every assigned runtime in
   parallel with a scan prompt. Each Markdown report is staged in the
   aggregator bucket. The aggregator harness (provisioned by the stack, with a
   Lambda-backed AgentCore Gateway exposing MCP tools) reads the staged reports
   and writes the consolidated report, which is stored on the assessment.
4. **Live output.** Each agent's streamed response is mirrored to a
   [Durable Streams](https://durablestreams.com) stream that the browser tails
   over `/sync/*`, with reads gated by the API's session check.

### What gets deployed

One CDK stack (`AgenticMigration`) creates:

| Area | Resources |
|---|---|
| Network | VPC (2 AZs, 1 NAT gateway; 3/3 with `isProd`), flow logs, security groups |
| Compute | ECS cluster on AWS Fargate with three services: `web`, `api`, `streams`; AWS Cloud Map namespace `platform.internal` |
| Edge | Amazon CloudFront distribution with a VPC origin to an internal Application Load Balancer |
| Identity | Amazon Cognito user pool with Managed Login (self sign-up disabled), Better Auth sessions |
| Data | Amazon Aurora PostgreSQL Serverless v2 (RDS Data API enabled), migration Lambda, AWS Secrets Manager secrets |
| Storage | S3 aggregator bucket (staged reports) and access-log bucket; IAM role and security groups for Amazon S3 Files |
| Agents | AgentCore Harness `aggregator_agent` (Anthropic Claude Sonnet via Amazon Bedrock) and AgentCore Gateway `aggregator-gateway` with a Node.js Lambda target |

Per-journey S3 Files file systems, access points and mount targets are created
at runtime by the API, not by CDK. See [Cleanup](#cleanup).

## Repository layout

```
apps/
  api/        Bun + Elysia + oRPC API. All AWS calls happen here.
  web/        TanStack Start (React 19, Vite) console.
  streams/    Durable Streams server image (Caddy plugin build).
  infra/      AWS CDK application.
packages/
  auth/       Better Auth configuration (Cognito social provider).
  database/   Drizzle ORM schema, client and migrations.
  ui/, biome-config/, typescript-config/   Shared tooling.
scripts/
  setup-env.sh   Populates local .env files from the deployed stack.
```

## Prerequisites

* An AWS account with permission to deploy the stack, and
  [access to Anthropic Claude models in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
  in the target region.
* One or more Amazon Bedrock AgentCore agent runtimes to act as the scan
  agents. Any runtime that can read a mounted file system and answer a prompt
  with Markdown will work.
* [Bun](https://bun.sh) 1.3+, Node.js 24+, Docker (with Compose), the AWS CLI,
  and a bootstrapped CDK environment (`bunx cdk bootstrap`).

## Deploy

```sh
bun install

cd apps/infra
bunx cdk deploy          # builds the three container images and deploys the stack
```

After the first deploy, apply the database schema by invoking the migration
Lambda once:

```sh
aws lambda invoke --function-name AgenticMigration-migrate /dev/stdout
```

Create a user in the Cognito user pool (self sign-up is disabled) with an
email and a full name, then open the CloudFront URL printed in the stack
outputs and sign in.

`isProd` in `apps/infra/bin/infra.ts` switches the stack to retain data on
destroy, use isolated database subnets, and run three NAT gateways. It is off
by default so `cdk destroy` removes everything.

## Run locally

Local development uses the deployed stack for Cognito, S3 Files, and the
aggregator, and Docker for Postgres and Durable Streams.

```sh
bun run setup        # writes apps/web/.env, apps/api/.env, packages/database/.env
bun run db:up        # Postgres + Durable Streams via docker compose
bun run --filter @repo/database db:push
bun run dev          # web on :3000, api on :4000
```

`apps/*/.env.example` document every key `setup` writes. Other useful
commands: `bun run lint`, `bun run check-types`, `bun run build`, and in
`apps/infra`: `bun run synth`, `bun run diff`.

## Security

This sample makes trade-offs that you should understand before deploying it:

* **Authentication.** Every oRPC procedure requires a Better Auth session
  (`apps/api/src/orpc/base.ts`); browser reads of live streams are gated by the
  API's `/auth/verify`. Error messages from AWS SDK calls are returned to
  signed-in users so the wizard can explain failures.
* **The API modifies IAM and AgentCore resources at runtime.** The API task
  role can `iam:PutRolePolicy`/`DeleteRolePolicy` on any role in the account
  (to attach journey-scoped S3 Files policies to agent execution roles),
  `iam:PassRole` to AgentCore, and update any agent runtime's network and
  mount configuration. Several statements use `Resource: "*"` because the user
  picks arbitrary runtimes. See `apps/infra/lib/construct/api.ts` for the
  rationale next to each grant.
* **The aggregator's `run_sql` tool** executes SQL generated by the model
  against the application database through the RDS Data API.
* **Database placement.** Without `isProd`, Aurora is placed in public subnets
  (security-group restricted) so it is reachable during development; `isProd`
  moves it to isolated subnets. Connections verify the RDS certificate
  authority bundle that is added to each image at build time.
* **Local development** uses plaintext credentials in `docker-compose.yml`
  (`postgres`/`postgres`, a fixed streams writer token). They are never
  deployed. `scripts/setup-env.sh` writes the Cognito client secret into
  `.env` files, which are git-ignored.
* `cdk-nag` (`AwsSolutionsChecks`) runs on every synth. Suppressions live next
  to the resources they cover.

Report security issues through the
[AWS vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/),
not GitHub issues.

### Usage metrics

The stack appends the identifier `AWSSOLUTION/SO0352/<version>` to the
`User-Agent` header of the AWS SDK calls this sample makes, so AWS can measure
how the solution is used. No additional data is collected or sent. To opt out,
remove the `UserAgentAspect` from `apps/infra/bin/infra.ts` (and
`USER_AGENT_STRING` from `apps/api/.env` for local development).

## Costs

Resources bill while deployed: one NAT gateway, three Fargate tasks, an Aurora
Serverless v2 writer, an internal ALB, CloudFront, a Cognito user pool on the
Plus feature plan, Secrets Manager secrets, and the AgentCore harness and
gateway. Each assessment also consumes Bedrock model tokens and AgentCore
runtime time for the aggregator and for your own agent runtimes. Use the
[AWS Pricing Calculator](https://calculator.aws/) for an estimate in your
region, and destroy the stack when you are done.

## Cleanup

1. Delete every journey in the UI first. This removes the S3 Files file
   systems, access points, mount targets (which hold ENIs in the VPC) and the
   inline IAM policies written to your agent execution roles. These resources
   are not managed by CloudFormation.
2. Then:

   ```sh
   cd apps/infra && bunx cdk destroy
   ```

With `isProd` enabled, the S3 buckets, Aurora cluster and Cognito user pool
are retained and must be deleted manually.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project has adopted the
[Amazon Open Source Code of Conduct](CODE_OF_CONDUCT.md).

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE)
file. Third-party code included in this repository is listed in
[THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES).
