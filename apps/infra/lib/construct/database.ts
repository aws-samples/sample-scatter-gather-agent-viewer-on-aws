import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { Construct } from 'constructs';
import * as path from 'node:path';

export interface DatabaseStackProps {
  vpc: ec2.IVpc;
  isProd?: boolean;
}

export class DatabaseStack extends Construct {
  public readonly postgresCluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    const { vpc } = props;
    const isProd = props.isProd ?? false;

    const subnetGroup = new rds.SubnetGroup(this, 'DB Subnet Group', {
      description: 'Subnet group for CS Agents Aurora PostgreSQL cluster',
      vpc,
      vpcSubnets: {
        subnetType: isProd
          ? ec2.SubnetType.PRIVATE_ISOLATED
          : ec2.SubnetType.PUBLIC,
      },
    });

    this.postgresCluster = new rds.DatabaseCluster(this, 'Postgres DB', {
      subnetGroup,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_9,
      }),
      defaultDatabaseName: 'app',
      autoMinorVersionUpgrade: true,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      storageEncrypted: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      deletionProtection: isProd,
      enableDataApi: true,
      vpc,
    });

    const migrationFn = new nodejs.NodejsFunction(this, 'DB Migration Function', {
      functionName: `${cdk.Aws.STACK_NAME}-migrate`,
      entry: path.join(import.meta.dirname, 'database-migrate.function.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      vpc,
      timeout: cdk.Duration.minutes(5),
      environment: {
        DATABASE_SECRET_ARN: this.postgresCluster.secret!.secretArn,
      },
      bundling: {
        commandHooks: {
          beforeBundling: (inputDir, outputDir) => [
            `cp -r ${path.join(inputDir, 'packages', 'database', 'drizzle')} ${outputDir}`,
            // RDS certificate authorities so the Lambda verifies Aurora's TLS
            // certificate instead of skipping verification.
            `curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o ${path.join(outputDir, 'rds-global-bundle.pem')}`,
          ],
          beforeInstall: () => [],
          afterBundling: () => []
        },
      }
    })

    this.postgresCluster.secret!.grantRead(migrationFn);

    this.postgresCluster.connections.allowDefaultPortFrom(
      migrationFn,
      'Allow migration Lambda to connect to Aurora PostgreSQL',
    );
  }
}