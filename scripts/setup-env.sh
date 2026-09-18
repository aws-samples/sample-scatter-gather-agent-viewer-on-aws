#!/usr/bin/env bash
#
# Local setup: pulls the AWS configuration needed for local development from
# the deployed CDK stack and writes it into the project's .env files.
#
# Usage: bun run setup   (or: turbo run setup)
#
# Uses the default AWS profile / credential chain. Override the stack or
# region with STACK_NAME / AWS_REGION if needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_NAME="${STACK_NAME:-AgenticMigration}"
REGION="${AWS_REGION:-$(aws configure get region || true)}"
REGION="${REGION:-us-east-1}"

WEB_ENV="$REPO_ROOT/apps/web/.env"
API_ENV="$REPO_ROOT/apps/api/.env"
DB_ENV="$REPO_ROOT/packages/database/.env"

# Upsert KEY=VALUE into an .env file, preserving all other lines.
upsert_env() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  # Ensure the file ends with a newline so appended keys land on their own line.
  if [[ -s "$file" && "$(tail -c 1 "$file")" != "" ]]; then
    echo >> "$file"
  fi
  if grep -q "^${key}=" "$file"; then
    # BSD sed (macOS) requires the '' after -i
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

echo "Fetching resources from CloudFormation stack '${STACK_NAME}' (${REGION})..."

RESOURCES="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?starts_with(ResourceType, 'AWS::Cognito::')].[ResourceType,PhysicalResourceId]" \
  --output text)"

USERPOOL_ID="$(echo "$RESOURCES" | awk '$1 == "AWS::Cognito::UserPool" {print $2}')"
CLIENT_ID="$(echo "$RESOURCES" | awk '$1 == "AWS::Cognito::UserPoolClient" {print $2}')"
DOMAIN_PREFIX="$(echo "$RESOURCES" | awk '$1 == "AWS::Cognito::UserPoolDomain" {print $2}')"

if [[ -z "$USERPOOL_ID" || -z "$CLIENT_ID" || -z "$DOMAIN_PREFIX" ]]; then
  echo "error: could not resolve Cognito resources from stack '${STACK_NAME}'." >&2
  echo "Is the stack deployed? (cd apps/infra && turbo run deploy)" >&2
  exit 1
fi

COGNITO_DOMAIN="${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"

# The app client is created with generateSecret: true, so the OAuth token
# exchange requires the client secret as well.
CLIENT_SECRET="$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USERPOOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" \
  --query "UserPoolClient.ClientSecret" \
  --output text)"

if [[ -z "$CLIENT_SECRET" || "$CLIENT_SECRET" == "None" ]]; then
  echo "error: could not retrieve the Cognito app client secret." >&2
  exit 1
fi

# Use one local Better Auth secret for every process that shares auth state.
LOCAL_AUTH_SECRET="$(grep -m1 '^BETTER_AUTH_SECRET=' "$WEB_ENV" 2>/dev/null | cut -d= -f2- || true)"
if [[ -z "$LOCAL_AUTH_SECRET" ]]; then
  LOCAL_AUTH_SECRET="$(grep -m1 '^BETTER_AUTH_SECRET=' "$API_ENV" 2>/dev/null | cut -d= -f2- || true)"
fi
if [[ -z "$LOCAL_AUTH_SECRET" ]]; then
  LOCAL_AUTH_SECRET="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)"
fi

# --- apps/web/.env ---
upsert_env "$WEB_ENV" "COGNITO_CLIENT_ID" "$CLIENT_ID"
upsert_env "$WEB_ENV" "COGNITO_CLIENT_SECRET" "$CLIENT_SECRET"
upsert_env "$WEB_ENV" "COGNITO_DOMAIN" "$COGNITO_DOMAIN"
upsert_env "$WEB_ENV" "COGNITO_REGION" "$REGION"
upsert_env "$WEB_ENV" "COGNITO_USERPOOL_ID" "$USERPOOL_ID"
upsert_env "$WEB_ENV" "BETTER_AUTH_SECRET" "$LOCAL_AUTH_SECRET"
upsert_env "$WEB_ENV" "BETTER_AUTH_URL" "http://localhost:4000"
upsert_env "$WEB_ENV" "VITE_API_URL" "http://localhost:4000"
grep -q '^DATABASE_URL=' "$WEB_ENV" || \
  upsert_env "$WEB_ENV" "DATABASE_URL" "postgresql://postgres:postgres@localhost:5432/app"

# --- apps/api/.env ---
upsert_env "$API_ENV" "COGNITO_CLIENT_ID" "$CLIENT_ID"
upsert_env "$API_ENV" "COGNITO_CLIENT_SECRET" "$CLIENT_SECRET"
upsert_env "$API_ENV" "COGNITO_DOMAIN" "$COGNITO_DOMAIN"
upsert_env "$API_ENV" "COGNITO_REGION" "$REGION"
upsert_env "$API_ENV" "COGNITO_USERPOOL_ID" "$USERPOOL_ID"
upsert_env "$API_ENV" "BETTER_AUTH_SECRET" "$LOCAL_AUTH_SECRET"
upsert_env "$API_ENV" "BETTER_AUTH_URL" "http://localhost:4000"
grep -q '^DATABASE_URL=' "$API_ENV" || \
  upsert_env "$API_ENV" "DATABASE_URL" "postgresql://postgres:postgres@localhost:5432/app"

# --- S3 Files sync role (used by createJourney to provision file systems) ---
S3_FILES_ROLE_NAME="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role' && starts_with(LogicalResourceId, 'S3FilesSyncRole')].PhysicalResourceId" \
  --output text)"

if [[ -n "$S3_FILES_ROLE_NAME" && "$S3_FILES_ROLE_NAME" != "None" ]]; then
  S3_FILES_ROLE_ARN="$(aws iam get-role \
    --role-name "$S3_FILES_ROLE_NAME" \
    --query "Role.Arn" \
    --output text)"
  upsert_env "$API_ENV" "S3_FILES_ROLE_ARN" "$S3_FILES_ROLE_ARN"
else
  echo "warning: S3 Files sync role not found in stack '${STACK_NAME}'." >&2
  echo "         Deploy the latest infra (cd apps/infra && bunx cdk deploy) and re-run setup." >&2
fi

# --- S3 Files mount target network (subnets + security group for journey mount targets) ---
MOUNT_SG_ID="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup' && starts_with(LogicalResourceId, 'S3FilesMountTargetSecurityGroup')].PhysicalResourceId" \
  --output text)"

AGENT_SG_ID="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup' && starts_with(LogicalResourceId, 'S3FilesAgentSecurityGroup')].PhysicalResourceId" \
  --output text)"

MOUNT_SUBNET_IDS="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::Subnet' && contains(LogicalResourceId, 'PrivateSubnet')].PhysicalResourceId" \
  --output text | tr '\t' ',')"

if [[ -n "$MOUNT_SG_ID" && "$MOUNT_SG_ID" != "None" && -n "$MOUNT_SUBNET_IDS" ]]; then
  upsert_env "$API_ENV" "S3_FILES_MOUNT_SECURITY_GROUP_ID" "$MOUNT_SG_ID"
  upsert_env "$API_ENV" "S3_FILES_MOUNT_SUBNET_IDS" "$MOUNT_SUBNET_IDS"
  [[ -n "$AGENT_SG_ID" && "$AGENT_SG_ID" != "None" ]] && \
    upsert_env "$API_ENV" "AGENT_VPC_SECURITY_GROUP_ID" "$AGENT_SG_ID"
else
  echo "warning: S3 Files mount target network not found in stack '${STACK_NAME}'." >&2
  echo "         Deploy the latest infra (cd apps/infra && bunx cdk deploy) and re-run setup." >&2
fi

# --- Solution user agent (read from the deployed stack's description so it stays in sync with apps/infra/lib/solution.ts) ---
STACK_DESCRIPTION="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Description" \
  --output text)"
if [[ "$STACK_DESCRIPTION" =~ \(([A-Z]+[0-9]+)\).*Version[[:space:]]+(v[0-9][^[:space:]]*) ]]; then
  upsert_env "$API_ENV" "USER_AGENT_STRING" "AWSSOLUTION/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
fi

# --- Durable Streams (local docker-compose service; deployed API gets these from ECS) ---
grep -q '^DURABLE_STREAMS_URL=' "$API_ENV" || \
  upsert_env "$API_ENV" "DURABLE_STREAMS_URL" "http://localhost:4437/v1/stream"
grep -q '^DURABLE_STREAMS_WRITER_TOKEN=' "$API_ENV" || \
  upsert_env "$API_ENV" "DURABLE_STREAMS_WRITER_TOKEN" "local-dev-writer-token"

# --- Assessment orchestration (aggregator bucket + runtime, from stack outputs) ---
AGGREGATOR_BUCKET_NAME="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AggregatorBucketName'].OutputValue" \
  --output text)"

AGGREGATOR_RUNTIME_ARN="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AggregatorRuntimeArn'].OutputValue" \
  --output text)"

if [[ -n "$AGGREGATOR_BUCKET_NAME" && "$AGGREGATOR_BUCKET_NAME" != "None" && \
      -n "$AGGREGATOR_RUNTIME_ARN" && "$AGGREGATOR_RUNTIME_ARN" != "None" ]]; then
  upsert_env "$API_ENV" "AGGREGATOR_BUCKET_NAME" "$AGGREGATOR_BUCKET_NAME"
  upsert_env "$API_ENV" "AGGREGATOR_RUNTIME_ARN" "$AGGREGATOR_RUNTIME_ARN"
else
  echo "warning: aggregator outputs not found in stack '${STACK_NAME}'; assessments will not run locally." >&2
  echo "         Deploy the latest infra (cd apps/infra && bunx cdk deploy) and re-run setup." >&2
fi

# --- packages/database/.env ---
grep -q '^DATABASE_URL=' "$DB_ENV" || \
  upsert_env "$DB_ENV" "DATABASE_URL" "postgresql://postgres:postgres@127.0.0.1:5432/app"

echo ""
echo "Wrote AWS config to:"
echo "  apps/web/.env          Cognito, Better Auth, and database configuration"
echo "  apps/api/.env          Cognito, Better Auth, S3 Files, aggregator, and database configuration"
echo "  packages/database/.env DATABASE_URL (local default, only if missing)"
echo ""
echo "Done. Start the app with: bun run db:up && bun run dev"
