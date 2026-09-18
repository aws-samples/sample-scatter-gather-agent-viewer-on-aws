import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface StreamsStackProps {
  readonly cluster: ecs.ICluster;
  /** The API service: answers forward_auth checks and is the only writer. */
  readonly apiService: ecs.FargateService;
  readonly apiPort: number;
}

/**
 * Durable Streams server (https://durablestreams.com/deployment) as a Fargate
 * service running the Caddy-plugin build from apps/streams.
 *
 * Assessment runs append every sub-agent's and the aggregator's streamed
 * output to per-source streams here. Browsers tail them at /sync/* straight
 * from the ALB; Caddy `forward_auth`s each read to the API's /auth/verify
 * (Better Auth session cookie) and holds the long-lived SSE connection itself,
 * so stream bytes never pass through the API process. Writes require the
 * shared writer token, which only the API holds.
 *
 * Single task with ephemeral storage: streams are live-run scratch, and the
 * durable artefacts (reports) land in Postgres/S3 via the API.
 */
export class StreamsStack extends Construct {
  public readonly service: ecs.FargateService;
  public readonly containerPort = 4437;
  /** Protocol endpoint for the API (writer), e.g. http://streams.platform.internal:4437/v1/stream */
  public readonly baseUrl: string;
  /** Bearer token the API presents to create/append/close streams. */
  public readonly writerToken: sm.ISecret;

  constructor(scope: Construct, id: string, props: StreamsStackProps) {
    super(scope, id);

    this.writerToken = new sm.Secret(this, 'Writer Token', {
      description: 'Bearer token the API uses to write to the Durable Streams server',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    const apiCloudMap = props.apiService.cloudMapService!;
    const authUpstream = `${apiCloudMap.serviceName}.${apiCloudMap.namespace.namespaceName}:${props.apiPort}`;

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Streams Task Definition', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    taskDefinition.addContainer('streams', {
      containerName: 'streams',
      image: ecs.ContainerImage.fromAsset(
        path.resolve(import.meta.dirname, '..', '..', '..', 'streams'),
        { platform: ecrAssets.Platform.LINUX_ARM64 },
      ),
      portMappings: [{ containerPort: this.containerPort }],
      environment: { AUTH_UPSTREAM: authUpstream },
      secrets: { WRITER_TOKEN: ecs.Secret.fromSecretsManager(this.writerToken) },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'streams' }),
      healthCheck: {
        command: ['CMD-SHELL', `curl -fsS http://127.0.0.1:${this.containerPort}/health || exit 1`],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(3),
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    const securityGroup = new ec2.SecurityGroup(this, 'StreamsSG', {
      vpc: props.cluster.vpc,
      description: 'Durable Streams server - ALB (reads) and API (writes) only',
      allowAllOutbound: true,
    });

    this.service = new ecs.FargateService(this, 'Streams Service', {
      serviceName: 'Streams',
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      cloudMapOptions: {
        name: 'streams', // streams.platform.internal
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
      // One writer with task-local storage: never run two copies at once.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });

    const cloudMap = this.service.cloudMapService!;
    this.baseUrl = `http://${cloudMap.serviceName}.${cloudMap.namespace.namespaceName}:${this.containerPort}/v1/stream`;

    // API -> streams (writes) and streams -> API (forward_auth).
    this.service.connections.allowFrom(
      props.apiService,
      ec2.Port.tcp(this.containerPort),
      'API service writes to Durable Streams',
    );
    props.apiService.connections.allowFrom(
      this.service,
      ec2.Port.tcp(props.apiPort),
      'Durable Streams forward_auth to API',
    );
  }
}
