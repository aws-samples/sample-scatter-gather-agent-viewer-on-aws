import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface EcsClusterStackProps {
  vpc: ec2.Vpc;
}

export class EcsClusterStack extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly namespace: servicediscovery.INamespace;

  constructor(scope: Construct, id: string, props: EcsClusterStackProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: cdk.Aws.STACK_NAME,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: {
        name: 'platform.internal',
      },
    });

    this.namespace = this.cluster.defaultCloudMapNamespace!;
  }
}
