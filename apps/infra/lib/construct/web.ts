import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as path from 'node:path';

import { Construct } from 'constructs';

export interface EcsProps {
    cluster: ecs.ICluster;
    apiService: ecs.FargateService;
    logBucket: s3.IBucket;
    postgresCluster: rds.DatabaseCluster;
    userPool: cognito.UserPool;
    userPoolClient: cognito.UserPoolClient;
    cognitoDomain: cognito.UserPoolDomain;
    betterAuthSecret: sm.ISecret;
    cognitoClientSecret: sm.ISecret;
}

export class WebStack extends Construct {
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: EcsProps) {
    super(scope, id);

    // Derive the internal API endpoint from the service's Cloud Map
    // registration and container port so it stays in sync with ApiStack.
    const apiCloudMap = props.apiService.cloudMapService!;
    const apiPort = props.apiService.taskDefinition.defaultContainer!.containerPort;
    const apiUrl = `http://${apiCloudMap.serviceName}.${apiCloudMap.namespace.namespaceName}:${apiPort}`;

    // Build context is the repo root so the monorepo workspace resolves.
    // This file is in apps/infra/lib/construct, so four levels up.
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');

    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Tanstack Service', {
      serviceName: 'Web',
      cluster: props.cluster,
      enableExecuteCommand: true,
      cpu: 1024,
      memoryLimitMiB: 2048,
      publicLoadBalancer: false,
      openListener: false,
      minHealthyPercent: 100,
      idleTimeout: cdk.Duration.seconds(300),
      circuitBreaker: {
        rollback: true
      },
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(repoRoot, {
          file: 'apps/web/Dockerfile',
          platform: ecrAssets.Platform.LINUX_AMD64,
        }),
        containerPort: 3000,
        environment: {
          NODE_ENV: 'production',

          API_URL: apiUrl,

          COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId, 
          COGNITO_DOMAIN: `${props.cognitoDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`, // e.g. "your-app.auth.us-east-1.amazoncognito.com"
          COGNITO_REGION: cdk.Aws.REGION, // e.g. "us-east-1"
          COGNITO_USERPOOL_ID: props.userPool.userPoolId, 

          DB_HOST: props.postgresCluster.clusterEndpoint.hostname,
          DB_PORT: props.postgresCluster.clusterEndpoint.port.toString(),
          DB_NAME: 'app',
        },
        secrets: {
          DB_USER: ecs.Secret.fromSecretsManager(props.postgresCluster.secret!, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(props.postgresCluster.secret!, 'password'),
          BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(props.betterAuthSecret),
          COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(props.cognitoClientSecret),
        },
      },
    });

    // Health check configuration
    this.service.targetGroup.configureHealthCheck({
      path: '/login',
    });

    // Allow the web service to reach the internal API (api.platform.internal)
    props.apiService.connections.allowFrom(
      this.service.service,
      ec2.Port.tcp(apiPort),
      'Web frontend to backend API',
    );

    props.postgresCluster.connections.allowDefaultPortFrom(this.service.service);
    this.service.loadBalancer.logAccessLogs(props.logBucket, 'alb');

    this.service.loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList('pl-3b927c52'),
      ec2.Port.tcp(80),
      'CloudFront VPC origin (origin-facing managed prefix list) to ALB',
    );

  }

  public setAppUrl(url: string): void {
    this.service.taskDefinition.defaultContainer?.addEnvironment('BETTER_AUTH_URL', url);
  }
}