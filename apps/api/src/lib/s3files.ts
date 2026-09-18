import {
	CreateAccessPointCommand,
	CreateFileSystemCommand,
	CreateMountTargetCommand,
	DeleteAccessPointCommand,
	DeleteFileSystemCommand,
	DeleteMountTargetCommand,
	GetAccessPointCommand,
	GetFileSystemCommand,
	GetMountTargetCommand,
	ResourceNotFoundException,
	S3FilesClient,
} from "@aws-sdk/client-s3files";
import { awsSdkConfig } from "./aws-sdk";

const client = new S3FilesClient(awsSdkConfig);

// Where journey access points are mounted on agent runtimes.
export const SOURCE_MOUNT_PATH = "/mnt/source";
export const TARGET_MOUNT_PATH = "/mnt/target";

// Non-root POSIX identity. S3 Files exposes objects as root:root with 644/755
// permissions by default, so a non-root user can read but not write. Hard
// enforcement (denying s3files:ClientWrite) belongs in the file system policy.
const READ_ONLY_POSIX_USER = { uid: 1000, gid: 1000 };

const FILE_SYSTEM_READY_TIMEOUT_MS = 60_000;
const FILE_SYSTEM_POLL_INTERVAL_MS = 2_000;

function requireRoleArn(): string {
	const roleArn = process.env.S3_FILES_ROLE_ARN;
	if (!roleArn) {
		throw new Error(
			"S3_FILES_ROLE_ARN is not set. It must point to an IAM role that grants the S3 Files service access to the journey bucket.",
		);
	}
	return roleArn;
}

function mountTargetNetwork(): {
	subnetIds: string[];
	securityGroupId: string;
} {
	const subnetIds =
		process.env.S3_FILES_MOUNT_SUBNET_IDS?.split(",")
			.map((id) => id.trim())
			.filter(Boolean) ?? [];
	const securityGroupId = process.env.S3_FILES_MOUNT_SECURITY_GROUP_ID;

	if (subnetIds.length === 0 || !securityGroupId) {
		throw new Error(
			"S3_FILES_MOUNT_SUBNET_IDS and S3_FILES_MOUNT_SECURITY_GROUP_ID must be set so journey file systems get mount targets in the VPC.",
		);
	}

	return { subnetIds, securityGroupId };
}

/** Strips leading/trailing slashes so "/src/app/" and "src/app" are equivalent. */
export function normalizePath(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

async function waitForFileSystemAvailable(fileSystemId: string) {
	const deadline = Date.now() + FILE_SYSTEM_READY_TIMEOUT_MS;

	while (true) {
		const { status, statusMessage } = await client.send(new GetFileSystemCommand({ fileSystemId }));

		if (status === "available") {
			return;
		}
		if (status === "error") {
			throw new Error(`File system ${fileSystemId} entered error state: ${statusMessage ?? "unknown"}`);
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for file system ${fileSystemId} to become available (last status: ${status})`);
		}

		await new Promise((resolve) => setTimeout(resolve, FILE_SYSTEM_POLL_INTERVAL_MS));
	}
}

export type MountTargetsStatus = {
	/** Every mount target is available (or there are none to wait for). */
	ready: boolean;
	total: number;
	available: number;
	/** Set when any mount target is in an error state. */
	error?: string;
};

/**
 * One-shot readiness check for a journey's mount targets, for the assessment
 * wizard to poll. Mount targets take a few minutes to provision after journey
 * creation; a UI poll is the right place to wait, not an RPC.
 */
export async function getMountTargetsStatus(mountTargetIds: string[]): Promise<MountTargetsStatus> {
	const statuses = await Promise.all(
		mountTargetIds.map((mountTargetId) => client.send(new GetMountTargetCommand({ mountTargetId }))),
	);
	const available = statuses.filter((status) => status.status === "available").length;
	const failed = statuses.find((status) => status.status === "error");
	return {
		ready: available === mountTargetIds.length,
		total: mountTargetIds.length,
		available,
		...(failed
			? { error: `Mount target ${failed.mountTargetId} entered error state: ${failed.statusMessage ?? "unknown"}` }
			: {}),
	};
}

export type JourneyFileSystem = {
	fileSystemId: string;
	fileSystemArn: string;
	source: { accessPointId: string; accessPointArn: string };
	target: { accessPointId: string; accessPointArn: string } | null;
	/** One mount target per configured subnet (one per AZ). */
	mountTargetIds: string[];
};

/**
 * Provisions the S3 Files resources backing a journey: one file system scoped
 * to the journey bucket, a read-only access point per environment (source
 * always, target only when a target path was given), and a mount target per
 * VPC subnet so compute in the VPC can mount the file system over NFS.
 */
export async function provisionJourneyFileSystem(options: {
	journeyId: string;
	bucketName: string;
	sourcePath: string;
	targetPath?: string;
}): Promise<JourneyFileSystem> {
	const roleArn = requireRoleArn();
	const network = mountTargetNetwork();

	const fileSystem = await client.send(
		new CreateFileSystemCommand({
			bucket: `arn:aws:s3:::${options.bucketName}`,
			roleArn,
			acceptBucketWarning: true,
			clientToken: `journey-fs-${options.journeyId}`,
			tags: [{ key: "Name", value: `journey-${options.journeyId}` }],
		}),
	);

	if (!fileSystem.fileSystemId || !fileSystem.fileSystemArn) {
		throw new Error("CreateFileSystem did not return a file system id");
	}

	await waitForFileSystemAvailable(fileSystem.fileSystemId);

	const createAccessPoint = async (kind: "source" | "target", path: string) => {
		const accessPoint = await client.send(
			new CreateAccessPointCommand({
				fileSystemId: fileSystem.fileSystemId,
				posixUser: READ_ONLY_POSIX_USER,
				rootDirectory: { path: `/${normalizePath(path)}` },
				clientToken: `journey-ap-${kind}-${options.journeyId}`,
				tags: [{ key: "Name", value: `journey-${options.journeyId}-${kind}` }],
			}),
		);

		if (!accessPoint.accessPointId || !accessPoint.accessPointArn) {
			throw new Error(`CreateAccessPoint (${kind}) did not return an id`);
		}

		return {
			accessPointId: accessPoint.accessPointId,
			accessPointArn: accessPoint.accessPointArn,
		};
	};

	const source = await createAccessPoint("source", options.sourcePath);
	const target = options.targetPath ? await createAccessPoint("target", options.targetPath) : null;

	const mountTargetIds: string[] = [];
	for (const subnetId of network.subnetIds) {
		const mountTarget = await client.send(
			new CreateMountTargetCommand({
				fileSystemId: fileSystem.fileSystemId,
				subnetId,
				securityGroups: [network.securityGroupId],
			}),
		);

		if (!mountTarget.mountTargetId) {
			throw new Error(`CreateMountTarget did not return an id for subnet ${subnetId}`);
		}
		mountTargetIds.push(mountTarget.mountTargetId);
	}

	return {
		fileSystemId: fileSystem.fileSystemId,
		fileSystemArn: fileSystem.fileSystemArn,
		source,
		target,
		mountTargetIds,
	};
}

const DELETE_TIMEOUT_MS = 180_000;
const DELETE_POLL_INTERVAL_MS = 5_000;

/** True when the error means the resource is already gone. */
function isGone(error: unknown): boolean {
	return error instanceof ResourceNotFoundException;
}

/**
 * Polls until `probe` reports the resource is gone. S3 Files deletes are
 * asynchronous, and a file system cannot be deleted while it still has mount
 * targets or access points, so each stage has to actually disappear before the
 * next one is attempted.
 */
async function waitUntilGone(label: string, probe: () => Promise<unknown>): Promise<void> {
	const deadline = Date.now() + DELETE_TIMEOUT_MS;

	while (true) {
		try {
			await probe();
		} catch (error) {
			if (isGone(error)) {
				return;
			}
			throw error;
		}

		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${label} to be deleted`);
		}
		await new Promise((resolve) => setTimeout(resolve, DELETE_POLL_INTERVAL_MS));
	}
}

export type JourneyFileSystemTeardown = {
	fileSystemId?: string | null;
	accessPointIds?: (string | null)[];
	mountTargetIds?: string[] | null;
};

/**
 * Tears down the S3 Files resources provisioned for a journey, in dependency
 * order: mount targets first (they hold ENIs in our subnets), then access
 * points, then the file system itself. Every stage waits for the resource to
 * actually disappear, because S3 Files rejects deleting a file system that
 * still has children.
 *
 * Idempotent: resources that are already gone are skipped, so a failed delete
 * can safely be retried.
 *
 * The journey's S3 bucket is customer-owned and is never touched.
 */
export async function deleteJourneyFileSystem(resources: JourneyFileSystemTeardown): Promise<void> {
	const mountTargetIds = resources.mountTargetIds ?? [];
	const accessPointIds = (resources.accessPointIds ?? []).filter((id): id is string => Boolean(id));

	// Mount targets can be deleted concurrently; each takes a while because the
	// service has to tear down an ENI.
	await Promise.all(
		mountTargetIds.map(async (mountTargetId) => {
			try {
				await client.send(new DeleteMountTargetCommand({ mountTargetId }));
			} catch (error) {
				if (!isGone(error)) throw error;
				return;
			}
			await waitUntilGone(`mount target ${mountTargetId}`, () =>
				client.send(new GetMountTargetCommand({ mountTargetId })),
			);
		}),
	);

	await Promise.all(
		accessPointIds.map(async (accessPointId) => {
			try {
				await client.send(new DeleteAccessPointCommand({ accessPointId }));
			} catch (error) {
				if (!isGone(error)) throw error;
				return;
			}
			await waitUntilGone(`access point ${accessPointId}`, () =>
				client.send(new GetAccessPointCommand({ accessPointId })),
			);
		}),
	);

	if (!resources.fileSystemId) {
		return;
	}

	const fileSystemId = resources.fileSystemId;
	try {
		// Deliberately not passing forceDelete: that flag discards data still
		// pending export to S3. Journey mounts are read-only, so there should be
		// nothing pending, and failing loudly beats silently dropping writes.
		await client.send(new DeleteFileSystemCommand({ fileSystemId }));
	} catch (error) {
		if (!isGone(error)) throw error;
		return;
	}

	await waitUntilGone(`file system ${fileSystemId}`, () => client.send(new GetFileSystemCommand({ fileSystemId })));
}
