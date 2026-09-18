import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { aggregatorToolDefinitions } from './aggregator-tools.schema';

export interface AggregatorToolsGatewayProps {
  postgresCluster: rds.DatabaseCluster;
  aggregatorBucket: s3.Bucket;
}

export class AggregatorToolsGateway extends Construct {
  public readonly gateway: agentcore.Gateway;

  constructor(scope: Construct, id: string, props: AggregatorToolsGatewayProps) {
    super(scope, id);

    /*********************** Gateway tools Lambda ***********************/

    const toolsFunction = new NodejsFunction(this, 'Tools Function', {
      entry: path.join(import.meta.dirname, 'aggregator-tools.function.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(5),
      // Bundle the SDK clients rather than relying on the runtime's SDK
      // snapshot, which may lag behind for newer services like AgentCore.
      bundling: { externalModules: [] },
      environment: {
        AGGREGATOR_BUCKET_NAME: props.aggregatorBucket.bucketName,
        DB_CLUSTER_ARN: props.postgresCluster.clusterArn,
        DB_SECRET_ARN: props.postgresCluster.secret!.secretArn,
        DB_NAME: 'app',
      },
    });

    props.aggregatorBucket.grantRead(toolsFunction);
    props.postgresCluster.grantDataApiAccess(toolsFunction);
    props.postgresCluster.secret!.grantRead(toolsFunction);
    toolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:ListAgentRuntimes',
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeForUser',
        ],
        resources: ['*'],
      }),
    );

    /**************************** Gateway *******************************/

    this.gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: 'aggregator-gateway',
      description: 'MCP tools the aggregator harness uses to reach other resources',
      authorizerConfiguration: new agentcore.IamAuthorizer(),
    });

    // addLambdaTarget also grants the gateway's role invoke on the Lambda.
    this.gateway.addLambdaTarget('Tools Target', {
      gatewayTargetName: 'aggregator-tools',
      lambdaFunction: toolsFunction,
      credentialProviderConfigurations: [
        new agentcore.GatewayIamRoleCredentialProviderConfig(),
      ],
      toolSchema: agentcore.ToolSchema.fromInline(aggregatorToolDefinitions),
    });
  }
}
