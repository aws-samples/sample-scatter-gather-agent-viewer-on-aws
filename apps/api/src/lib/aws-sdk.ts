/**
 * Shared configuration for every AWS SDK client the API creates.
 *
 * USER_AGENT_STRING (`AWSSOLUTION/<id>/<version>`) is injected by the CDK
 * stack (apps/infra/lib/solution.ts) and appended to the User-Agent header so
 * service API usage can be attributed to this solution. Locally it comes from
 * apps/api/.env; when unset the SDK default user agent is used unchanged.
 */
export const awsSdkConfig = {
	customUserAgent: process.env.USER_AGENT_STRING,
};
