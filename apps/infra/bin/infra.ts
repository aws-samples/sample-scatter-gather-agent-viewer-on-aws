import { App, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { InfraStack } from "../lib/infra-stack";
import { SOLUTION_ID, SOLUTION_NAME, SOLUTION_VERSION, UserAgentAspect } from "../lib/solution";

const app = new App();

new InfraStack(app, "AgenticMigration", {
	description: `(${SOLUTION_ID}) - ${SOLUTION_NAME}. Version ${SOLUTION_VERSION}`,
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION,
	},
	// isProd: true,
});

Aspects.of(app).add(new UserAgentAspect());
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
