import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SecretsStackProps {
  readonly userPoolClient: cognito.UserPoolClient;
}

export class SecretsStack extends Construct {
  /** Secret used by Better Auth to sign session tokens. */
  public readonly betterAuthSecret: sm.Secret;

  /**
   * Cognito app client secret used by Better Auth for the OAuth
   * code-for-token exchange.
   *
   * The app client is created with generateSecret: true, and its secret is
   * only available as a deploy-time SecretValue token (resolved via a custom
   * resource calling DescribeUserPoolClient). ECS can only inject secrets
   * from Secrets Manager or SSM, so we materialize it here instead of
   * exposing it as a plaintext environment variable.
   */
  public readonly cognitoClientSecret: sm.Secret;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id);

    this.betterAuthSecret = new sm.Secret(this, 'Better Auth Secret', {
      secretName: `${cdk.Aws.STACK_NAME}_BETTER-AUTH_Secret`,
      description: 'Secret used by BETTER-AUTH to sign session tokens',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    this.cognitoClientSecret = new sm.Secret(this, 'Cognito Client Secret', {
      secretName: `${cdk.Aws.STACK_NAME}_COGNITO-CLIENT_Secret`,
      description: 'Cognito app client secret used by Better Auth for the token exchange',
      secretStringValue: props.userPoolClient.userPoolClientSecret,
    });
  }
}
