import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";

export interface ApiStackProps {
	readonly cluster: ecs.ICluster;
	readonly postgresCluster: rds.DatabaseCluster;
	readonly userPool: cognito.UserPool;
	readonly userPoolClient: cognito.UserPoolClient;
	readonly cognitoDomain: cognito.UserPoolDomain;
	readonly betterAuthSecret: sm.ISecret;
	readonly cognitoClientSecret: sm.ISecret;
	readonly s3FilesSyncRole: iam.IRole;
	readonly s3FilesMountTargetSecurityGroup: ec2.ISecurityGroup;
	readonly s3FilesAgentSecurityGroup: ec2.ISecurityGroup;
	readonly s3FilesMountTargetSubnets: ec2.ISubnet[];
	readonly aggregatorBucket: s3.IBucket;
	readonly aggregatorRuntimeArn: string;
}

export class ApiStack extends Construct {
	public readonly backendService: ecs.FargateService;
	public readonly containerPort = 4000;

	constructor(scope: Construct, id: string, props: ApiStackProps) {
		super(scope, id);

		// Task Definition
		const taskDefinition = new ecs.FargateTaskDefinition(
			this,
			"Api Task Definition",
			{
				cpu: 1024,
				memoryLimitMiB: 2048,
				runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
			},
		);

		const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

		taskDefinition.addContainer("api", {
			containerName: "api",
			image: ecs.ContainerImage.fromAsset(repoRoot, {
				file: "apps/api/Dockerfile",
				platform: ecrAssets.Platform.LINUX_ARM64,
				exclude: ["apps/web/*", "!apps/web/package.json"],
			}),
			portMappings: [{ containerPort: this.containerPort }],
			environment: {
				NODE_ENV: "production",
				PORT: String(this.containerPort),

				// @repo/auth reads these for the Cognito social provider.
				COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
				COGNITO_DOMAIN: `${props.cognitoDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
				COGNITO_REGION: cdk.Aws.REGION,
				COGNITO_USERPOOL_ID: props.userPool.userPoolId,

				// @repo/database builds its pool from these discrete parts.
				DB_HOST: props.postgresCluster.clusterEndpoint.hostname,
				DB_PORT: cdk.Token.asString(props.postgresCluster.clusterEndpoint.port),
				DB_NAME: "app",

				S3_FILES_ROLE_ARN: props.s3FilesSyncRole.roleArn,
				S3_FILES_MOUNT_SUBNET_IDS: props.s3FilesMountTargetSubnets
					.map((subnet) => subnet.subnetId)
					.join(","),
				S3_FILES_MOUNT_SECURITY_GROUP_ID:
					props.s3FilesMountTargetSecurityGroup.securityGroupId,
				AGENT_VPC_SECURITY_GROUP_ID:
					props.s3FilesAgentSecurityGroup.securityGroupId,

				AGGREGATOR_BUCKET_NAME: props.aggregatorBucket.bucketName,
				AGGREGATOR_RUNTIME_ARN: props.aggregatorRuntimeArn,
			},
			secrets: {
				DB_USER: ecs.Secret.fromSecretsManager(
					props.postgresCluster.secret!,
					"username",
				),
				DB_PASSWORD: ecs.Secret.fromSecretsManager(
					props.postgresCluster.secret!,
					"password",
				),
				BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(
					props.betterAuthSecret,
				),
				COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
					props.cognitoClientSecret,
				),
			},
			logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api" }),
		});

		// Security Group — only allow traffic from frontend
		const backendSg = new ec2.SecurityGroup(this, "BackendSG", {
			vpc: props.cluster.vpc,
			description: "Backend service - internal only",
			allowAllOutbound: true,
		});

		// Fargate Service with Cloud Map registration
		this.backendService = new ecs.FargateService(this, "Backend Service", {
			serviceName: "Api",
			cluster: props.cluster,
			taskDefinition,
			desiredCount: 1,
			assignPublicIp: false, // No public IP — internal only
			vpcSubnets: {
				subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // Private subnet
			},
			securityGroups: [backendSg],
			cloudMapOptions: {
				name: "api", // Registers as api.platform.internal
				dnsRecordType: servicediscovery.DnsRecordType.A,
				dnsTtl: cdk.Duration.seconds(10),
			},
			minHealthyPercent: 100,
			// Fail the deployment fast if tasks crash on boot instead of retrying
			// for up to three hours.
			circuitBreaker: { rollback: true },
		});

		props.postgresCluster.connections.allowDefaultPortFrom(
			this.backendService,
			"API service to Postgres",
		);

		/********************************************************************/
		/************************* AWS permissions **************************/
		/********************************************************************/
		// Every AWS API call in this system is made by the API container — the web
		// app has no AWS SDK dependency and reaches all of this over oRPC. Grants
		// belong here, next to the code that uses them.

		// Agent inspection and reconfiguration:
		//   src/orpc/router/agents.ts        — ListAgentRuntimes, GetAgentRuntime
		//   src/orpc/router/journey-agents.ts — UpdateAgentRuntime, UpdateHarness
		//   src/lib/agent-permissions.ts     — SimulatePrincipalPolicy
		// Unscoped because the caller chooses an arbitrary agent runtime, and the
		// managing harness is discovered at runtime from a ValidationException
		// rather than known at synth time.
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"bedrock-agentcore:ListAgentRuntimes",
					"bedrock-agentcore:GetAgentRuntime",
					"bedrock-agentcore:UpdateAgentRuntime",
					"bedrock-agentcore:UpdateHarness",
					// Validate agent execution role permissions in the wizard.
					"iam:SimulatePrincipalPolicy",
				],
				resources: ["*"],
			}),
		);

		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["cloudwatch:GetMetricData"],
				resources: ["*"],
			}),
		);

		// Assessment runs invoke the assigned sub-agent runtimes (scatter) and
		// the aggregator runtime (gather). Harness-managed runtimes reject direct
		// invocation, so the run also lists/inspects harnesses to find the owner
		// and calls InvokeHarness. Unscoped because the sub-agents are whatever
		// runtimes the user assigned to the journey. src/lib/run-assessment.ts
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"bedrock-agentcore:InvokeAgentRuntime",
					"bedrock-agentcore:InvokeHarness",
					"bedrock-agentcore:ListHarnesses",
					"bedrock-agentcore:GetHarness",
				],
				resources: ["*"],
			}),
		);

		// Sub-agent reports are staged in the aggregator bucket for the
		// aggregator's get_report tool; the final report is read back from it.
		props.aggregatorBucket.grantReadWrite(
			taskDefinition.taskRole,
			"assessments/*",
		);

		// Journey creation provisions an S3 Files file system + access points.
		// src/lib/s3files.ts
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"s3files:CreateFileSystem",
					"s3files:GetFileSystem",
					"s3files:CreateAccessPoint",
					"s3files:GetAccessPoint",
					"s3files:CreateMountTarget",
					"s3files:GetMountTarget",
					"s3files:TagResource",
					// Journey deletion tears these down in dependency order.
					"s3files:DeleteMountTarget",
					"s3files:DeleteAccessPoint",
					"s3files:DeleteFileSystem",
				],
				resources: [
					`arn:${cdk.Aws.PARTITION}:s3files:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:file-system/*`,
				],
			}),
		);

		// Mount target creation places service-managed ENIs into our subnets.
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"ec2:CreateNetworkInterface",
					"ec2:DescribeNetworkInterfaces",
					"ec2:DescribeSubnets",
					"ec2:DescribeSecurityGroups",
				],
				resources: ["*"],
			}),
		);

		// Journey bucket readiness checks and fixes (versioning + encryption),
		// limited to buckets owned by this account. src/lib/journey-bucket.ts
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"s3:*BucketVersioning",
					"s3:*EncryptionConfiguration",
					"s3:*BucketNotification",
				],
				resources: [`arn:${cdk.Aws.PARTITION}:s3:::*`],
				conditions: {
					StringEquals: { "aws:ResourceAccount": cdk.Aws.ACCOUNT_ID },
				},
			}),
		);

		// Bucket picker in the journey form. ListAllMyBuckets only supports the
		// wildcard resource; it returns names, not contents.
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["s3:ListAllMyBuckets"],
				resources: ["*"],
			}),
		);

		// Source/target path pickers: list folders under a prefix and confirm a
		// typed path exists. Key names only, never object contents, and only in
		// buckets this account owns. src/lib/journey-bucket.ts
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["s3:ListBucket"],
				resources: [`arn:${cdk.Aws.PARTITION}:s3:::*`],
				conditions: {
					StringEquals: { "aws:ResourceAccount": cdk.Aws.ACCOUNT_ID },
				},
			}),
		);

		// Quick-fix in the assessment wizard: attach the journey S3 Files inline
		// policy to agent execution roles. Broad by necessity (agent roles are
		// arbitrary) — the policy content written is limited to journey bucket
		// reads and s3files:ClientMount. src/lib/agent-permissions.ts
		// DeleteRolePolicy is the inverse, used when a journey is deleted to remove
		// the journey-scoped inline policy from agent execution roles.
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["iam:PutRolePolicy", "iam:DeleteRolePolicy"],
				resources: [
					`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/*`,
				],
			}),
		);

		// CreateFileSystem passes the sync role to the S3 Files service.
		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["iam:PassRole"],
				resources: [props.s3FilesSyncRole.roleArn],
				conditions: {
					StringEquals: {
						"iam:PassedToService": "elasticfilesystem.amazonaws.com",
					},
				},
			}),
		);

		taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["iam:PassRole"],
				resources: [
					`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/*`,
				],
				conditions: {
					StringEquals: {
						"iam:PassedToService": "bedrock-agentcore.amazonaws.com",
					},
				},
			}),
		);
	}

	/**
	 * Better Auth derives callbacks and redirects from its base URL, and rejects
	 * browser requests whose Origin is not trusted. Both are only known once the
	 * CloudFront distribution exists.
	 */
	public setAppUrl(url: string): void {
		const container = this.backendService.taskDefinition.defaultContainer;
		container?.addEnvironment("BETTER_AUTH_URL", url);
		container?.addEnvironment("TRUSTED_ORIGINS", url);
	}

	/**
	 * Live assessment output: runs append each agent's and the aggregator's
	 * streamed response to per-source Durable Streams, authenticated with the
	 * writer token. The streams service depends on this one (forward_auth), so
	 * it is created afterwards and wired in here. src/lib/assessment-streams.ts
	 */
	public setStreams(baseUrl: string, writerToken: sm.ISecret): void {
		const container = this.backendService.taskDefinition.defaultContainer;
		container?.addEnvironment("DURABLE_STREAMS_URL", baseUrl);
		container?.addSecret(
			"DURABLE_STREAMS_WRITER_TOKEN",
			ecs.Secret.fromSecretsManager(writerToken),
		);
	}
}
