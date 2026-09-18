import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IAspect } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/**
 * Solution identity, defined once and referenced everywhere it is needed
 * (stack description, AWS SDK user agent). Bump SOLUTION_VERSION on release.
 */
export const SOLUTION_ID = 'SO0352';
export const SOLUTION_VERSION = 'v0.1.0';
export const SOLUTION_NAME = 'Scatter Gather Agent Viewer';

/**
 * Appended to the User-Agent header of every AWS SDK call the solution makes
 * so service API usage can be attributed to it. Format is mandated by
 * https://w.amazon.com/bin/view/AWS/Solutions/SolutionsTeam/Metrics/user-agent/OnBoard
 */
export const USER_AGENT_STRING = `AWSSOLUTION/${SOLUTION_ID}/${SOLUTION_VERSION}`;

/** Environment variable the runtime code reads the user agent string from. */
export const USER_AGENT_ENV = 'USER_AGENT_STRING';

/**
 * Injects USER_AGENT_STRING into every Lambda function and ECS container in
 * the app so each AWS SDK client can pick it up (apps/api/src/lib/aws-sdk.ts,
 * the Lambda handlers under lib/construct).
 */
export class UserAgentAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof lambda.Function) {
      node.addEnvironment(USER_AGENT_ENV, USER_AGENT_STRING);
    } else if (node instanceof ecs.ContainerDefinition) {
      node.addEnvironment(USER_AGENT_ENV, USER_AGENT_STRING);
    }
  }
}
