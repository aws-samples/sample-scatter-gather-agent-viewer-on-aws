import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface S3FilesProps {
  vpc: ec2.Vpc;
}

/**
 * IAM role that the S3 Files service assumes to sync data between journey
 * file systems and their S3 buckets. Passed to CreateFileSystem as roleArn
 * when the API provisions a file system for a new journey.
 *
 * Policy follows the official template:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html
 *
 * Journey buckets are chosen by users at runtime, so the S3 statements are
 * scoped to the account (via aws:ResourceAccount) rather than a single bucket.
 */
export class S3FilesStack extends Construct {
  public readonly syncRole: iam.Role;
  /** Security group attached to journey mount target ENIs (NFS, port 2049). */
  public readonly mountTargetSecurityGroup: ec2.SecurityGroup;
  /** Security group the app attaches to agent runtimes it moves into the VPC. */
  public readonly agentSecurityGroup: ec2.SecurityGroup;
  /** Private subnets (one per AZ) where journey mount targets are created. */
  public readonly mountTargetSubnets: ec2.ISubnet[];

  constructor(scope: Construct, id: string, props: S3FilesProps) {
    super(scope, id);

    this.agentSecurityGroup = new ec2.SecurityGroup(this, 'Agent Security Group', {
      vpc: props.vpc,
      description: 'AgentCore runtimes attached to journey file systems',
      allowAllOutbound: true,
    });

    this.mountTargetSecurityGroup = new ec2.SecurityGroup(this, 'Mount Target Security Group', {
      vpc: props.vpc,
      description: 'S3 Files mount targets for journey file systems (NFS)',
      allowAllOutbound: false,
    });
    this.mountTargetSecurityGroup.addIngressRule(
      this.agentSecurityGroup,
      ec2.Port.tcp(2049),
      'NFS from journey agent runtimes',
    );

    this.mountTargetSubnets = props.vpc.privateSubnets;

    this.syncRole = new iam.Role(this, 'Sync Role', {
      description: 'Assumed by S3 Files to sync journey file systems with their S3 buckets',
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': `arn:${cdk.Aws.PARTITION}:s3files:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:file-system/*`,
          },
        },
      }),
    });

    this.syncRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BucketPermissions',
        actions: ['s3:ListBucket', 's3:ListBucketVersions'],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::*`],
        conditions: {
          StringEquals: { 'aws:ResourceAccount': cdk.Aws.ACCOUNT_ID },
        },
      }),
    );

    this.syncRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ObjectPermissions',
        actions: [
          's3:AbortMultipartUpload',
          's3:DeleteObject*',
          's3:GetObject*',
          's3:List*',
          's3:PutObject*',
        ],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::*/*`],
        conditions: {
          StringEquals: { 'aws:ResourceAccount': cdk.Aws.ACCOUNT_ID },
        },
      }),
    );

    this.syncRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseKmsKeyWithS3Files',
        actions: [
          'kms:GenerateDataKey',
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncryptFrom',
          'kms:ReEncryptTo',
        ],
        resources: [`arn:${cdk.Aws.PARTITION}:kms:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
        conditions: {
          StringLike: {
            'kms:ViaService': `s3.${cdk.Aws.REGION}.amazonaws.com`,
          },
        },
      }),
    );

    this.syncRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeManage',
        actions: [
          'events:DeleteRule',
          'events:DisableRule',
          'events:EnableRule',
          'events:PutRule',
          'events:PutTargets',
          'events:RemoveTargets',
        ],
        resources: [`arn:${cdk.Aws.PARTITION}:events:*:*:rule/DO-NOT-DELETE-S3-Files*`],
        conditions: {
          StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' },
        },
      }),
    );

    this.syncRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeRead',
        actions: [
          'events:DescribeRule',
          'events:ListRuleNamesByTarget',
          'events:ListRules',
          'events:ListTargetsByRule',
        ],
        resources: [`arn:${cdk.Aws.PARTITION}:events:*:*:rule/*`],
      }),
    );
  }
}
