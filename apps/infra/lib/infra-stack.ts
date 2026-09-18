import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { NetworkStack } from './construct/network';
import { WebStack } from './construct/web';
import { DatabaseStack } from './construct/database';
import { AuthStack } from './construct/authentication';
import { SecretsStack } from './construct/secrets';
import { CloudfrontStack } from './construct/cloudfront';
import { StorageStack } from './construct/storage';
import { S3FilesStack } from './construct/s3files';
import { AggregatorStack } from './construct/agentcore/runtimes/aggregator';
import { AggregatorToolsGateway } from './construct/agentcore/gateway/aggregator-tools';
import { ApiStack } from './construct/api';
import { EcsClusterStack } from './construct/ecs-cluster-stack';
import { StreamsStack } from './construct/streams';

export interface InfraStackProps extends cdk.StackProps {
  readonly isProd?: boolean;
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const isProd = props.isProd ?? false;

    /********************************************************************/
    /***************************** Network ******************************/
    /********************************************************************/

    const networkStack = new NetworkStack(this, 'Network', { isProd });

    /********************************************************************/
    /*************************** ECS Cluster ****************************/
    /********************************************************************/

    const ecsClusterStack = new EcsClusterStack(this, 'EcsCluster', {
      vpc: networkStack.vpc,
    });

    /********************************************************************/
    /***************************** Storage ******************************/
    /********************************************************************/

    const storageStack = new StorageStack(this, 'Storage', { isProd });

    /********************************************************************/
    /**************************** S3 Files ******************************/
    /********************************************************************/

    const s3FilesStack = new S3FilesStack(this, 'S3Files', {
      vpc: networkStack.vpc,
    });

    /********************************************************************/
    /************************* Authentication ***************************/
    /********************************************************************/

    const authStack = new AuthStack(this, 'Auth', { isProd });

    /********************************************************************/
    /****************************** Secrets *****************************/
    /********************************************************************/

    const secretsStack = new SecretsStack(this, 'Secrets', {
      userPoolClient: authStack.userPoolClient,
    });

    /********************************************************************/
    /**************************** Database ******************************/
    /********************************************************************/

    const databaseStack = new DatabaseStack(this, 'Database', {
      vpc: networkStack.vpc,
      isProd,
    });

    /********************************************************************/
    /********************* Aggregator Tools Gateway *********************/
    /********************************************************************/

    const aggregatorTools = new AggregatorToolsGateway(this, 'AggregatorTools', {
      postgresCluster: databaseStack.postgresCluster,
      aggregatorBucket: storageStack.aggregatorBucket,
    });

    /********************************************************************/
    /************************ Aggregator Agent **************************/
    /********************************************************************/

    const aggregatorStack = new AggregatorStack(this, 'Aggregator', {
      toolsGateway: aggregatorTools.gateway,
      aggregatorBucket: storageStack.aggregatorBucket,
    });

    const apiStack = new ApiStack(this, 'Api', {
      cluster: ecsClusterStack.cluster,
      postgresCluster: databaseStack.postgresCluster,
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
      cognitoDomain: authStack.userPoolDomain,
      betterAuthSecret: secretsStack.betterAuthSecret,
      cognitoClientSecret: secretsStack.cognitoClientSecret,
      s3FilesSyncRole: s3FilesStack.syncRole,
      s3FilesMountTargetSecurityGroup: s3FilesStack.mountTargetSecurityGroup,
      s3FilesAgentSecurityGroup: s3FilesStack.agentSecurityGroup,
      s3FilesMountTargetSubnets: s3FilesStack.mountTargetSubnets,
      aggregatorBucket: storageStack.aggregatorBucket,
      aggregatorRuntimeArn: aggregatorStack.runtimeArn,
    });

    /********************************************************************/
    /************************* Durable Streams **************************/
    /********************************************************************/

    const streamsStack = new StreamsStack(this, 'Streams', {
      cluster: ecsClusterStack.cluster,
      apiService: apiStack.backendService,
      apiPort: apiStack.containerPort,
    });
    apiStack.setStreams(streamsStack.baseUrl, streamsStack.writerToken);

    /********************************************************************/
    /**************************** Web Stack *****************************/
    /********************************************************************/

    const webStack = new WebStack(this, 'Web', {
      cluster: ecsClusterStack.cluster,
      apiService: apiStack.backendService,
      logBucket: storageStack.logBucket,
      postgresCluster: databaseStack.postgresCluster,
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
      cognitoDomain: authStack.userPoolDomain,
      betterAuthSecret: secretsStack.betterAuthSecret,
      cognitoClientSecret: secretsStack.cognitoClientSecret,
    });

    /********************************************************************/
    /*********************** API routing on the ALB *********************/
    /********************************************************************/

    webStack.service.listener.addTargets('ApiTarget', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/api/*',
          '/rpc/*',
        ]),
      ],
      port: apiStack.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiStack.backendService.loadBalancerTarget({ containerName: 'api' })],
      healthCheck: { path: '/health' },
    });

    // Live assessment streams go straight to the Durable Streams server; it
    // forward_auths every read to the API's /auth/verify. Long-lived SSE
    // connections, so give the target group a matching idle timeout.
    webStack.service.listener.addTargets('StreamsTarget', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/sync/*'])],
      port: streamsStack.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [streamsStack.service.loadBalancerTarget({ containerName: 'streams' })],
      healthCheck: { path: '/health' },
    });

    // /********************************************************************/
    // /**************************** CloudFront ****************************/
    // /********************************************************************/

    const cloudfrontStack = new CloudfrontStack(this, 'CDN', {
      loadBalancer: webStack.service.loadBalancer,
      logBucket: storageStack.logBucket,
    });

    webStack.setAppUrl(`https://${cloudfrontStack.distribution.distributionDomainName}`);
    apiStack.setAppUrl(`https://${cloudfrontStack.distribution.distributionDomainName}`);
    authStack.addCallbackUrl(`https://${cloudfrontStack.distribution.distributionDomainName}/api/auth/callback/cognito`);

    /********************************************************************/
    /***************************** Outputs ******************************/
    /********************************************************************/
    // Consumed by scripts/setup-env.sh to configure local development.

    new cdk.CfnOutput(this, 'AggregatorBucketName', {
      value: storageStack.aggregatorBucket.bucketName,
      description: 'Bucket where assessment sub-agent reports are collected',
    });
    new cdk.CfnOutput(this, 'AggregatorRuntimeArn', {
      value: aggregatorStack.runtimeArn,
      description: 'Agent runtime ARN of the aggregator harness',
    });

    /********************************************************************/
    /************************ cdk-nag acknowledgements ******************/
    /********************************************************************/
    // The AWS Solutions rule pack runs on every synth (bin/infra.ts). The
    // findings below are deliberate for this sample; each reason points at
    // the code that explains the trade-off. Revisit them before running this
    // stack in an environment with real data.

    // IAM5 is a granular rule: one finding per wildcard action/resource, each
    // acknowledged individually so a new wildcard shows up as a new finding.
    const iam5 = (target: string, reason: string) => ({
      id: `AwsSolutions-IAM5[${target}]`,
      reason,
    });
    const operatorChosenResources =
      'The operator selects arbitrary AgentCore runtimes and S3 buckets at runtime, so the resource is not known at synth time. See the inline comments in lib/construct/api.ts.';
    const cdkGrant =
      'Wildcard emitted by a CDK grant helper (bucket.grantReadWrite, Lambda log/ECR access, execution roles).';
    const s3FilesTemplate =
      'Matches the IAM policy Amazon S3 Files requires for its sync role; see lib/construct/s3files.ts.';
    const harnessBaseline =
      'Baseline permissions for an AgentCore harness runtime (logs, workload identity, memory, harness image pulls); see lib/construct/agentcore/runtimes/aggregator.ts.';

    cdk.Validations.of(this).acknowledge(
      iam5('Resource::*', operatorChosenResources),
      iam5('Resource::arn:<AWS::Partition>:s3:::*', operatorChosenResources),
      iam5('Resource::arn:<AWS::Partition>:s3:::*/*', s3FilesTemplate),
      iam5('Resource::arn:<AWS::Partition>:iam::<AWS::AccountId>:role/*', operatorChosenResources),
      iam5('Resource::arn:<AWS::Partition>:s3files:<AWS::Region>:<AWS::AccountId>:file-system/*', 'File systems are created per journey at runtime; see lib/construct/api.ts.'),
      iam5('Action::s3:*BucketVersioning', operatorChosenResources),
      iam5('Action::s3:*EncryptionConfiguration', operatorChosenResources),
      iam5('Action::s3:*BucketNotification', operatorChosenResources),
      iam5('Action::s3:List*', cdkGrant),
      iam5('Action::s3:GetObject*', cdkGrant),
      iam5('Action::s3:GetBucket*', cdkGrant),
      iam5('Action::s3:DeleteObject*', cdkGrant),
      iam5('Action::s3:PutObject*', cdkGrant),
      iam5('Action::s3:Abort*', cdkGrant),
      iam5('Resource::<StorageAggregatorBucketD7CDB570.Arn>/*', cdkGrant),
      iam5('Resource::<StorageAggregatorBucketD7CDB570.Arn>/assessments/*', cdkGrant),
      iam5('Resource::<AggregatorToolsToolsFunctionCF80903D.Arn>:*', 'AgentCore Gateway invokes every version/alias of its Lambda target.'),
      iam5('Resource::arn:<AWS::Partition>:kms:<AWS::Region>:<AWS::AccountId>:*', s3FilesTemplate),
      iam5('Resource::arn:<AWS::Partition>:events:*:*:rule/DO-NOT-DELETE-S3-Files*', s3FilesTemplate),
      iam5('Resource::arn:<AWS::Partition>:events:*:*:rule/*', s3FilesTemplate),
      iam5('Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:*', harnessBaseline),
      iam5('Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/bedrock-agentcore/runtimes/*', harnessBaseline),
      iam5('Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*', harnessBaseline),
      iam5('Resource::arn:<AWS::Partition>:ecr:<AWS::Region>:*:repository/harness-*', harnessBaseline),
      iam5('Resource::arn:<AWS::Partition>:bedrock-agentcore:<AWS::Region>:<AWS::AccountId>:workload-identity-directory/default/workload-identity/*', harnessBaseline),
      iam5('Resource::arn:<AWS::Partition>:bedrock-agentcore:<AWS::Region>:<AWS::AccountId>:memory/*', harnessBaseline),
      {
        id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        reason: 'Standard Lambda CloudWatch Logs permissions.',
      },
      {
        id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole]',
        reason: 'The migration Lambda runs inside the VPC and needs ENI management.',
      },

      {
        id: 'AwsSolutions::AwsSolutions-SMG4',
        reason:
          'Secrets (Better Auth key, Cognito client secret, streams writer token, Aurora credentials) are generated per deployment and consumed by long-running ECS tasks; rotation would require a coordinated restart and is out of scope for this sample.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-ECS2',
        reason:
          'Only non-sensitive configuration (service URLs, resource identifiers, region) is passed as plain environment variables. Credentials are injected from Secrets Manager via ECS secrets.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-RDS6',
        reason:
          'The application authenticates to Aurora with the RDS-managed Secrets Manager credential injected into the ECS tasks; IAM database authentication is not used by the Drizzle/pg client in this sample.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-RDS10',
        reason:
          'Deletion protection is enabled when isProd is true (lib/construct/database.ts). It is off by default so `cdk destroy` can remove the sample cleanly.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-CFR4',
        reason:
          'The distribution uses the default *.cloudfront.net certificate so the sample deploys without a custom domain; attach an ACM certificate and domain to enforce TLS 1.2 for viewers.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-CFR1',
        reason: 'Geo restriction is a deployment-specific choice left to the operator.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-CFR2',
        reason: 'AWS WAF is recommended for any long-lived deployment but is out of scope for this sample.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-COG2',
        reason:
          'Self sign-up is disabled and users are created by an administrator; enable MFA on the user pool for any deployment beyond evaluation.',
      },
    );
  }
}
