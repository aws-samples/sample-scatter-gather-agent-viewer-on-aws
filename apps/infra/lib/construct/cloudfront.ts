import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface CloudfrontStackProps {
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly logBucket: s3.IBucket;
}

export class CloudfrontStack extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudfrontStackProps) {
    super(scope, id);

    const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      readTimeout: cdk.Duration.seconds(120),
      keepaliveTimeout: cdk.Duration.seconds(120),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${cdk.Aws.STACK_NAME} - TanStack Start app`,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket: props.logBucket,
      logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: vpcOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    });
  }
}
