import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface AuthStackProps {
  readonly isProd?: boolean;
}

export class AuthStack extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id);

    const isProd = props.isProd ?? false;

    this.userPool = new cognito.UserPool(this, 'User Pool', {
      userPoolName: cdk.Aws.STACK_NAME,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: isProd
        ? cognito.StandardThreatProtectionMode.FULL_FUNCTION
        : cognito.StandardThreatProtectionMode.NO_ENFORCEMENT,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolDomain = this.userPool.addDomain('Hosted Domain', {
      cognitoDomain: {
        domainPrefix: cdk.Stack.of(this).stackName.toLowerCase(),
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    this.userPoolClient = this.userPool.addClient('App Client', {
      userPoolClientName: cdk.Aws.STACK_NAME,
      generateSecret: true,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.EMAIL,
        ],
        // Non-prod: allow local development against the deployed pool.
        // Prod: no localhost callback — the CloudFront URL is always
        // added via addCallbackUrl() once it's known (see below).
        callbackUrls: isProd
          ? undefined
          : ['http://localhost:4000/api/auth/callback/cognito'],
      },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    if (isProd) {
      // The L2 construct requires a non-empty callback list (it injects an
      // 'https://example.com' placeholder when none is given, and rejects
      // an empty array outright). Since the CloudFront URL is always added
      // via addCallbackUrl(), start from an empty list at the L1 level,
      // where that validation doesn't apply.
      const cfnClient = this.userPoolClient.node.defaultChild as cognito.CfnUserPoolClient;
      cfnClient.callbackUrLs = [];
    }

    new cognito.CfnManagedLoginBranding(this, 'Managed Login Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
  }

  public addCallbackUrl(url: string): void {
    const cfnClient = this.userPoolClient.node.defaultChild as cognito.CfnUserPoolClient;
    const existingUrls = cfnClient.callbackUrLs ?? [];

    cfnClient.callbackUrLs = [...existingUrls, url];
  }
}
