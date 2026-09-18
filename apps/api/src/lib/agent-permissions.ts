import {
  DeleteRolePolicyCommand,
  IAMClient,
  NoSuchEntityException,
  PutRolePolicyCommand,
  SimulatePrincipalPolicyCommand,
} from '@aws-sdk/client-iam'
import type { journey } from '@repo/database'
import { awsSdkConfig } from './aws-sdk'

const client = new IAMClient(awsSdkConfig)

export type PermissionCheck = {
  action: string
  resource: string
  allowed: boolean
}

export type PermissionsValidation = {
  configured: boolean
  /** Actions the execution role is missing. */
  missingActions: string[]
  checks: PermissionCheck[]
}

/**
 * The permissions an agent runtime's execution role needs to mount and read
 * a journey file system, per the S3 Files compute-role prerequisites:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html
 * - s3files:ClientMount on the file system (read-only client access)
 * - direct S3 read on the journey bucket (the mount helper reads objects
 *   straight from S3 for performance)
 */
function accessPointArns(record: typeof journey.$inferSelect): string[] {
  return [record.sourceAccessPointArn, record.targetAccessPointArn].filter(
    (arn): arn is string => Boolean(arn),
  )
}

function requiredPermissions(
  record: typeof journey.$inferSelect,
): { action: string; resource: string }[] {
  const bucketArn = `arn:aws:s3:::${record.bucketName}`
  const fileSystemArn = record.fileSystemArn ?? '*'

  return [
    { action: 's3files:ClientMount', resource: fileSystemArn },
    // AgentCore's runtime control service resolves the file system and its
    // mount targets through the execution role when attaching the mounts.
    { action: 's3files:GetFileSystem', resource: fileSystemArn },
    { action: 's3files:ListMountTargets', resource: fileSystemArn },
    ...accessPointArns(record).map((arn) => ({
      action: 's3files:GetAccessPoint',
      resource: arn,
    })),
    { action: 's3:GetObject', resource: `${bucketArn}/*` },
    { action: 's3:GetObjectVersion', resource: `${bucketArn}/*` },
    { action: 's3:ListBucket', resource: bucketArn },
  ]
}

/**
 * Simulates the runtime execution role against the permissions required to
 * mount and read the journey file system. Uses the IAM policy simulator, so
 * managed and inline identity policies are evaluated; resource policies
 * (like the file system policy) are not part of the simulation.
 */
export async function checkAgentPermissions(
  record: typeof journey.$inferSelect,
  executionRoleArn: string,
): Promise<PermissionsValidation> {
  const required = requiredPermissions(record)

  // One simulation per resource shape keeps action<->resource pairing exact.
  const checks: PermissionCheck[] = await Promise.all(
    required.map(async ({ action, resource }) => {
      const result = await client.send(
        new SimulatePrincipalPolicyCommand({
          PolicySourceArn: executionRoleArn,
          ActionNames: [action],
          ResourceArns: resource === '*' ? undefined : [resource],
        }),
      )
      const decision = result.EvaluationResults?.[0]?.EvalDecision
      return { action, resource, allowed: decision === 'allowed' }
    }),
  )

  const missingActions = checks
    .filter((check) => !check.allowed)
    .map((check) => check.action)

  return {
    configured: missingActions.length === 0,
    missingActions,
    checks,
  }
}

/** Extracts the role name from an IAM role ARN (path segments included). */
function roleNameFromArn(roleArn: string): string {
  const rolePart = roleArn.split(':role/')[1]
  if (!rolePart) {
    throw new Error(`Not an IAM role ARN: ${roleArn}`)
  }
  const segments = rolePart.split('/')
  const name = segments[segments.length - 1]
  if (!name) {
    throw new Error(`Not an IAM role ARN: ${roleArn}`)
  }
  return name
}

/**
 * Grants the runtime execution role the permissions it needs to mount and
 * read the journey file system by attaching an inline policy, following the
 * compute-role template from the S3 Files prerequisites. The policy is named
 * after the journey so repeated fixes overwrite rather than accumulate.
 */
/** The inline policy name used for a journey's grant on an execution role. */
function journeyPolicyName(journeyId: string): string {
  return `journey-${journeyId}-s3files-access`
}

/**
 * Removes the inline policy that `grantAgentPermissions` attached to an agent
 * execution role. Idempotent: a role that was never granted, or has already had
 * the policy removed, is treated as success.
 */
export async function revokeAgentPermissions(
  journeyId: string,
  executionRoleArn: string,
): Promise<void> {
  try {
    await client.send(
      new DeleteRolePolicyCommand({
        RoleName: roleNameFromArn(executionRoleArn),
        PolicyName: journeyPolicyName(journeyId),
      }),
    )
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      return
    }
    throw error
  }
}

export async function grantAgentPermissions(
  record: typeof journey.$inferSelect,
  executionRoleArn: string,
): Promise<void> {
  const bucketArn = `arn:aws:s3:::${record.bucketName}`
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'JourneyFileSystemMount',
        Effect: 'Allow',
        Action: [
          's3files:ClientMount',
          's3files:GetFileSystem',
          's3files:ListMountTargets',
        ],
        // Mount targets are subresources of the file system, so cover both
        // the file system ARN and its subresource ARNs.
        Resource: record.fileSystemArn
          ? [record.fileSystemArn, `${record.fileSystemArn}/*`]
          : '*',
      },
      // AgentCore's runtime control service checks this on the execution
      // role when a filesystem configuration is attached to the runtime.
      ...(accessPointArns(record).length > 0
        ? [
            {
              Sid: 'JourneyAccessPointDescribe',
              Effect: 'Allow',
              Action: ['s3files:GetAccessPoint'],
              Resource: accessPointArns(record),
            },
          ]
        : []),
      {
        Sid: 'JourneyBucketObjectRead',
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:GetObjectVersionTagging',
        ],
        Resource: `${bucketArn}/*`,
      },
      {
        Sid: 'JourneyBucketList',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:ListBucketVersions'],
        Resource: bucketArn,
      },
    ],
  }

  await client.send(
    new PutRolePolicyCommand({
      RoleName: roleNameFromArn(executionRoleArn),
      PolicyName: journeyPolicyName(record.id),
      PolicyDocument: JSON.stringify(policy),
    }),
  )
}
