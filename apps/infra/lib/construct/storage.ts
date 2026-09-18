import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageStackProps {
  readonly isProd?: boolean;
}

export class StorageStack extends Construct {
  public readonly logBucket: s3.Bucket;
  public readonly aggregatorBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id);

    const isProd = props.isProd ?? false;
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.logBucket = new s3.Bucket(this, 'Access Logs Bucket', {
      bucketName: `${cdk.Stack.of(this).stackName.toLowerCase()}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-access-logs`,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !isProd,
      lifecycleRules: [{ expiration: cdk.Duration.days(isProd ? 365 : 90) }],
    });

    this.aggregatorBucket = new s3.Bucket(this, 'Aggregator Bucket', {
      bucketName: `${cdk.Stack.of(this).stackName.toLowerCase()}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-aggregator`,
      removalPolicy,
      autoDeleteObjects: !isProd,
      versioned: isProd,
      enforceSSL: true,
      serverAccessLogsBucket: this.logBucket,
      serverAccessLogsPrefix: 'aggregator/',
      lifecycleRules: [
        {
          id: 'expire-assessment-reports',
          prefix: 'assessments/',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });
  }
}
