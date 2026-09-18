import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface AggregatorStackProps {
  toolsGateway: agentcore.Gateway;
  aggregatorBucket: s3.Bucket;
}

export class AggregatorStack extends Construct {
  public readonly harness: agentcore.CfnHarness;

  /** ARN of the harness's underlying agent runtime, for InvokeAgentRuntime. */
  public get runtimeArn(): string {
    return this.harness.attrEnvironmentAgentCoreRuntimeEnvironmentAgentRuntimeArn;
  }

  constructor(scope: Construct, id: string, props: AggregatorStackProps) {
    super(scope, id);

    // Role the harness assumes when running the agent loop.
    const harnessRole = new iam.Role(this, 'Harness Role', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the aggregator AgentCore harness',
    });

    this.harness = new agentcore.CfnHarness(this, 'Aggregator Harness', {
      harnessName: 'aggregator_agent',
      executionRoleArn: harnessRole.roleArn,
      model: {
        bedrockModelConfig: {
          modelId: 'global.anthropic.claude-sonnet-5',
        },
      },
      systemPrompt: [
        {
          text: [
            'You are the aggregator agent of a scatter-gather migration',
            'platform. By the time you are invoked, the sub-agents have',
            'already run and their Markdown scan reports sit in the',
            'aggregator S3 bucket; the invocation prompt lists the report',
            'object keys. Use get_report to read every listed report, then',
            'produce a single consolidated Markdown assessment report:',
            'an executive summary, findings merged and de-duplicated across',
            'agents, risks, and recommended next steps. Respond with the',
            'final Markdown report only. If needed, run_sql can query the',
            'app database and invoke_sub_agent can re-run a sub-agent whose',
            'report is missing or unreadable.',
          ].join(' '),
        },
      ],
      tools: [
        {
          type: 'agentcore_gateway',
          name: 'aggregator-gateway',
          config: {
            agentCoreGateway: {
              gatewayArn: props.toolsGateway.gatewayArn,
              outboundAuth: { awsIam: {} },
            },
          },
        },
      ],
      environmentVariables: {
        AGGREGATOR_BUCKET_NAME: props.aggregatorBucket.bucketName,
      },
      maxTokens: 32000,
    });

    // Call the gateway's MCP tools.
    props.toolsGateway.grantInvoke(harnessRole);

    // The agent loop's model calls.
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    /********************************************************************/
    /******************* Harness runtime baseline ***********************/
    /********************************************************************/
    // A harness runs on a service-managed container that the execution role
    // itself has to be able to pull, log from, and identify with. Without
    // these the container never starts and every invocation dies with
    // "Runtime initialization time exceeded" and no log group. Mirrors the
    // policy the console attaches to its default harness role.

    const region = cdk.Aws.REGION;
    const account = cdk.Aws.ACCOUNT_ID;
    const partition = cdk.Aws.PARTITION;

    // Pull the managed harness image.
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EcrManagedImagePull',
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        resources: [`arn:${partition}:ecr:${region}:*:repository/harness-*`],
      }),
    );
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EcrTokens',
        actions: ['ecr:GetAuthorizationToken', 'ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken'],
        resources: ['*'],
      }),
    );

    // Runtime logs, metrics, and traces.
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogs',
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
          'logs:PutResourcePolicy',
        ],
        resources: [
          `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      }),
    );
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsDescribeGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:${partition}:logs:${region}:${account}:log-group:*`],
      }),
    );
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'XRayTracing',
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );

    // Workload identity for the runtime, and the harness's managed memory.
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreWorkloadIdentity',
        actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT'],
        resources: [
          `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );
    harnessRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreMemory',
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:DeleteEvent',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:RetrieveMemoryRecords',
        ],
        resources: [`arn:${partition}:bedrock-agentcore:${region}:${account}:memory/*`],
      }),
    );
  }
}
