import {
	GetBucketEncryptionCommand,
	GetBucketVersioningCommand,
	ListBucketsCommand,
	ListObjectsV2Command,
	PutBucketEncryptionCommand,
	PutBucketVersioningCommand,
	S3Client,
	S3ServiceException,
} from "@aws-sdk/client-s3";
import { awsSdkConfig } from "./aws-sdk";

const client = new S3Client(awsSdkConfig);

export type BucketReadiness = {
	/** Bucket exists and we were able to inspect it. */
	accessible: boolean;
	versioningEnabled: boolean;
	/** SSE-S3 or SSE-KMS, both accepted by S3 Files. */
	encryptionCompliant: boolean;
	/** Bucket meets every S3 Files prerequisite. */
	ready: boolean;
	/** Human-readable reason when the bucket could not be inspected. */
	error?: string;
};

function notReady(error: string): BucketReadiness {
	return {
		accessible: false,
		versioningEnabled: false,
		encryptionCompliant: false,
		ready: false,
		error,
	};
}

export type BucketSummary = {
	name: string;
	createdAt: Date | null;
};

/**
 * Lists the account's buckets in this region, for the journey form's bucket
 * picker. S3 Files file systems must be in the same region as their bucket,
 * so buckets elsewhere are excluded up front rather than failing later with
 * PermanentRedirect on the readiness check.
 */
export async function listRegionBuckets(): Promise<BucketSummary[]> {
	const region = await client.config.region();
	const buckets: BucketSummary[] = [];
	let continuationToken: string | undefined;

	do {
		const page = await client.send(
			new ListBucketsCommand({
				BucketRegion: region,
				MaxBuckets: 1000,
				ContinuationToken: continuationToken,
			}),
		);
		for (const bucket of page.Buckets ?? []) {
			if (bucket.Name) {
				buckets.push({ name: bucket.Name, createdAt: bucket.CreationDate ?? null });
			}
		}
		continuationToken = page.ContinuationToken;
	} while (continuationToken);

	return buckets.sort((a, b) => a.name.localeCompare(b.name));
}

/** Strips leading/trailing slashes; "" is the bucket root. */
function normalizePrefix(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Lists the "folders" (common prefixes) directly under a path, for the journey
 * form's path pickers. Returns paths relative to the bucket root without
 * trailing slashes, e.g. ["source", "source/app-code"].
 */
export async function listFolders(bucketName: string, path: string): Promise<string[]> {
	const prefix = normalizePrefix(path);
	const response = await client.send(
		new ListObjectsV2Command({
			Bucket: bucketName,
			Prefix: prefix === "" ? undefined : `${prefix}/`,
			Delimiter: "/",
			// One page is plenty for a picker; the user narrows by typing.
			MaxKeys: 200,
		}),
	);
	return (response.CommonPrefixes ?? [])
		.map((common) => common.Prefix?.replace(/\/$/, "") ?? "")
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

export type PathCheck = {
	/** At least one object exists under the path. */
	exists: boolean;
	error?: string;
};

/**
 * Whether a path holds any objects. S3 has no real folders, so "exists" means
 * some key starts with `path/`. The bucket root always exists.
 */
export async function checkPathExists(bucketName: string, path: string): Promise<PathCheck> {
	const prefix = normalizePrefix(path);
	if (prefix === "") {
		return { exists: true };
	}
	try {
		const response = await client.send(
			new ListObjectsV2Command({
				Bucket: bucketName,
				Prefix: `${prefix}/`,
				MaxKeys: 1,
			}),
		);
		return { exists: (response.KeyCount ?? 0) > 0 };
	} catch (error) {
		if (error instanceof S3ServiceException) {
			return { exists: false, error: `Could not inspect the path: ${error.name}` };
		}
		throw error;
	}
}

/**
 * Checks the S3 Files prerequisites on a bucket: versioning enabled and
 * SSE-S3/SSE-KMS encryption.
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html
 */
export async function checkBucketReadiness(bucketName: string): Promise<BucketReadiness> {
	try {
		const [versioning, encryption] = await Promise.all([
			client.send(new GetBucketVersioningCommand({ Bucket: bucketName })),
			client.send(new GetBucketEncryptionCommand({ Bucket: bucketName })),
		]);

		const versioningEnabled = versioning.Status === "Enabled";
		const algorithms =
			encryption.ServerSideEncryptionConfiguration?.Rules?.map(
				(rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
			) ?? [];
		const encryptionCompliant = algorithms.some((algorithm) => algorithm === "AES256" || algorithm === "aws:kms");

		return {
			accessible: true,
			versioningEnabled,
			encryptionCompliant,
			ready: versioningEnabled && encryptionCompliant,
		};
	} catch (error) {
		if (error instanceof S3ServiceException) {
			if (error.name === "NoSuchBucket" || error.name === "NotFound") {
				return notReady("Bucket does not exist");
			}
			if (error.name === "AccessDenied") {
				return notReady("Access denied when inspecting the bucket");
			}
			if (error.name === "PermanentRedirect") {
				return notReady("Bucket is in a different region");
			}
			return notReady(`Could not inspect bucket: ${error.name}`);
		}
		throw error;
	}
}

/**
 * Enables the missing S3 Files prerequisites on a bucket: turns on versioning
 * and applies SSE-S3 default encryption. Only touches settings that are
 * currently non-compliant. Returns the readiness state after the changes.
 */
export async function prepareBucket(bucketName: string): Promise<BucketReadiness> {
	const before = await checkBucketReadiness(bucketName);
	if (!before.accessible || before.ready) {
		return before;
	}

	if (!before.versioningEnabled) {
		await client.send(
			new PutBucketVersioningCommand({
				Bucket: bucketName,
				VersioningConfiguration: { Status: "Enabled" },
			}),
		);
	}

	if (!before.encryptionCompliant) {
		await client.send(
			new PutBucketEncryptionCommand({
				Bucket: bucketName,
				ServerSideEncryptionConfiguration: {
					Rules: [
						{
							ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
						},
					],
				},
			}),
		);
	}

	return checkBucketReadiness(bucketName);
}
