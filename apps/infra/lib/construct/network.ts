import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps {
  readonly isProd?: boolean;
}

export class NetworkStack extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id);

    const isProd = props.isProd ?? false;

    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: isProd ? 3 : 2,
      natGateways: isProd ? 3 : 1,
      flowLogs: {
        FlowLog: {
          trafficType: isProd
            ? ec2.FlowLogTrafficType.ALL
            : ec2.FlowLogTrafficType.REJECT,
        },
      },
    });
  }
}
