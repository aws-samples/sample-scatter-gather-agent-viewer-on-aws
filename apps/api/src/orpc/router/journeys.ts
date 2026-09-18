import { randomUUID } from "node:crypto";
import { db, journey, journeyAgent } from "@repo/database";
import { desc, eq } from "drizzle-orm";
import * as z from "zod";
import { revokeAgentPermissions } from "../../lib/agent-permissions";
import {
	type BucketReadiness,
	type BucketSummary,
	checkBucketReadiness,
	checkPathExists,
	listFolders,
	listRegionBuckets,
	type PathCheck,
	prepareBucket,
} from "../../lib/journey-bucket";
import { deleteJourneyFileSystem, normalizePath, provisionJourneyFileSystem } from "../../lib/s3files";
import { base as os } from "../base";
import { detachJourneyMounts } from "./journey-agents";

export type Journey = typeof journey.$inferSelect;

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const pathWithinBucket = z
	.string()
	.trim()
	.refine((value) => !value.startsWith("s3://"), "Provide the path within the bucket, not a full S3 URI")
	.refine((value) => value.length <= 1024, "Path is too long");

export const createJourneyInput = z.object({
	name: z.string().trim().min(1, "Name is required").max(120),
	bucketName: z.string().trim().regex(BUCKET_NAME_PATTERN, "Must be a valid S3 bucket name"),
	sourcePath: pathWithinBucket.refine((value) => value.length > 0, "Source path is required"),
	targetPath: pathWithinBucket.optional(),
	migrationType: z.string().trim().max(120).optional(),
	description: z.string().trim().max(2000).optional(),
});

export const listJourneys = os.input(z.object({})).handler(async (): Promise<Journey[]> => {
	return db.select().from(journey).orderBy(desc(journey.createdAt));
});

export const getJourney = os.input(z.object({ id: z.string() })).handler(async ({ input }): Promise<Journey | null> => {
	const [result] = await db.select().from(journey).where(eq(journey.id, input.id)).limit(1);

	return result ?? null;
});

const bucketNameInput = z.object({
	bucketName: z.string().trim().regex(BUCKET_NAME_PATTERN, "Must be a valid S3 bucket name"),
});

export const listJourneyBuckets = os.input(z.object({})).handler(async (): Promise<BucketSummary[]> => {
	return listRegionBuckets();
});

export const checkJourneyBucket = os.input(bucketNameInput).handler(async ({ input }): Promise<BucketReadiness> => {
	return checkBucketReadiness(input.bucketName);
});

export const prepareJourneyBucket = os.input(bucketNameInput).handler(async ({ input }): Promise<BucketReadiness> => {
	return prepareBucket(input.bucketName);
});

const bucketPathInput = bucketNameInput.extend({ path: pathWithinBucket });

/** Folders directly under a path, for the source/target path pickers. */
export const listJourneyFolders = os.input(bucketPathInput).handler(async ({ input }): Promise<string[]> => {
	return listFolders(input.bucketName, input.path);
});

export const checkJourneyPath = os.input(bucketPathInput).handler(async ({ input }): Promise<PathCheck> => {
	return checkPathExists(input.bucketName, input.path);
});

export const createJourney = os.input(createJourneyInput).handler(async ({ input }): Promise<Journey> => {
	const readiness = await checkBucketReadiness(input.bucketName);
	if (!readiness.ready) {
		throw new Error(
			readiness.error ?? "Bucket does not meet the S3 Files prerequisites (versioning and default encryption)",
		);
	}

	const id = randomUUID();
	const sourcePath = normalizePath(input.sourcePath);
	const targetPath = input.targetPath ? normalizePath(input.targetPath) : undefined;

	const fileSystem = await provisionJourneyFileSystem({
		journeyId: id,
		bucketName: input.bucketName,
		sourcePath,
		targetPath,
	});

	const [created] = await db
		.insert(journey)
		.values({
			id,
			name: input.name,
			bucketName: input.bucketName,
			sourcePath,
			targetPath: targetPath ?? null,
			migrationType: input.migrationType || null,
			description: input.description || null,
			fileSystemId: fileSystem.fileSystemId,
			fileSystemArn: fileSystem.fileSystemArn,
			sourceAccessPointId: fileSystem.source.accessPointId,
			sourceAccessPointArn: fileSystem.source.accessPointArn,
			targetAccessPointId: fileSystem.target?.accessPointId ?? null,
			targetAccessPointArn: fileSystem.target?.accessPointArn ?? null,
			mountTargetIds: fileSystem.mountTargetIds,
		})
		.returning();

	if (!created) {
		throw new Error("Failed to create journey");
	}

	return created;
});

export type JourneyDeletion = {
	journeyId: string;
	/** False only when the journey had no file system recorded. */
	deletedFileSystem: boolean;
	detachedAgents: number;
	revokedPolicies: number;
	/**
	 * Non-fatal problems. The journey is still deleted; these call out residue
	 * left in AWS that may need attention.
	 */
	warnings: string[];
};

/**
 * Deletes a journey and the AWS resources provisioned for it.
 *
 * Order matters. AWS teardown happens before the database row is removed,
 * because the row is the only record of which resources exist — dropping it
 * first would orphan the file system with no way to find it again. So the file
 * system teardown must succeed for the delete to proceed, and a failed delete
 * is safe to retry (every stage is idempotent).
 *
 * Detaching mounts and revoking IAM policies are best-effort: a runtime that
 * has since been deleted, or a role we can't write to, must not permanently
 * strand a journey. Those failures come back as warnings.
 *
 * The journey's S3 bucket belongs to the customer and is never deleted.
 */
export const deleteJourney = os
	.input(z.object({ id: z.string() }))
	.handler(async ({ input }): Promise<JourneyDeletion> => {
		const [record] = await db.select().from(journey).where(eq(journey.id, input.id)).limit(1);

		if (!record) {
			throw new Error(`Journey ${input.id} not found`);
		}

		// Read the agents before the delete: the row cascade removes them.
		const agents = await db.select().from(journeyAgent).where(eq(journeyAgent.journeyId, record.id));

		const warnings: string[] = [];

		// 1. Detach the journey's access points from each runtime, so nothing is
		//    left pointing at a file system that's about to disappear.
		const detachments = await detachJourneyMounts(
			record,
			agents.map((agent) => agent.agentRuntimeId),
		);
		for (const detachment of detachments) {
			if (detachment.error) {
				warnings.push(
					`Could not detach the file system from runtime ${detachment.agentRuntimeId}: ${detachment.error}`,
				);
			}
		}

		// 2. Revoke the per-journey inline policy from each execution role we
		//    resolved while detaching.
		let revokedPolicies = 0;
		await Promise.all(
			detachments.map(async (detachment) => {
				if (!detachment.roleArn) return;
				try {
					await revokeAgentPermissions(record.id, detachment.roleArn);
					revokedPolicies += 1;
				} catch (error) {
					warnings.push(
						`Could not remove the journey policy from ${detachment.roleArn}: ${
							error instanceof Error ? error.message : "unknown error"
						}`,
					);
				}
			}),
		);

		// 3. Tear down the file system. This one must succeed — see above.
		await deleteJourneyFileSystem({
			fileSystemId: record.fileSystemId,
			accessPointIds: [record.sourceAccessPointId, record.targetAccessPointId],
			mountTargetIds: record.mountTargetIds,
		});

		// 4. Finally the row, which cascades to journeyAgent and assessment.
		await db.delete(journey).where(eq(journey.id, record.id));

		return {
			journeyId: record.id,
			deletedFileSystem: Boolean(record.fileSystemId),
			detachedAgents: detachments.filter((item) => !item.error).length,
			revokedPolicies,
			warnings,
		};
	});
