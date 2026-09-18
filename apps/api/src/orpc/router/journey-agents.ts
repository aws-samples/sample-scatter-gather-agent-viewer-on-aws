import { randomUUID } from "node:crypto";
import {
	BedrockAgentCoreControlClient,
	type FilesystemConfiguration,
	GetAgentRuntimeCommand,
	type GetAgentRuntimeCommandOutput,
	type NetworkConfiguration,
	UpdateAgentRuntimeCommand,
	UpdateHarnessCommand,
	ValidationException,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { db, journey, journeyAgent } from "@repo/database";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { checkAgentPermissions, grantAgentPermissions } from "../../lib/agent-permissions";
import { awsSdkConfig } from "../../lib/aws-sdk";
import {
	getMountTargetsStatus,
	type MountTargetsStatus,
	SOURCE_MOUNT_PATH,
	TARGET_MOUNT_PATH,
} from "../../lib/s3files";
import { base as os } from "../base";

const client = new BedrockAgentCoreControlClient(awsSdkConfig);

export type JourneyAgent = typeof journeyAgent.$inferSelect;

const RUNTIME_READY_TIMEOUT_MS = 120_000;
const RUNTIME_POLL_INTERVAL_MS = 3_000;

export type AgentRuntimeValidation = {
	agentRuntimeId: string;
	agentRuntimeName: string | null;
	runtimeStatus: string | null;
	/** Check 1: runtime is in VPC mode, in our subnets, wearing the agent SG. */
	network: { configured: boolean; detail: string };
	/** Check 2: journey access points are mounted. */
	mounts: { configured: boolean; missingMounts: string[] };
	/** Check 3: execution role can mount the file system and read the bucket. */
	permissions: {
		configured: boolean;
		missingActions: string[];
		detail: string;
	};
	/** All checks pass. */
	configured: boolean;
	error?: string;
};

/**
 * Result of `validate`: the journey's file system readiness (shared by every
 * agent - mounts can't be attached until it's ready) plus one entry per
 * assigned runtime.
 */
export type JourneyAgentsValidation = {
	fileSystem: MountTargetsStatus;
	agents: AgentRuntimeValidation[];
};

function agentVpcNetwork(): { subnetIds: string[]; securityGroupId: string } {
	const subnetIds =
		process.env.S3_FILES_MOUNT_SUBNET_IDS?.split(",")
			.map((id) => id.trim())
			.filter(Boolean) ?? [];
	const securityGroupId = process.env.AGENT_VPC_SECURITY_GROUP_ID;

	if (subnetIds.length === 0 || !securityGroupId) {
		throw new Error(
			"S3_FILES_MOUNT_SUBNET_IDS and AGENT_VPC_SECURITY_GROUP_ID must be set to validate and configure agent runtime networking.",
		);
	}

	return { subnetIds, securityGroupId };
}

async function getJourneyOrThrow(journeyId: string) {
	const [record] = await db.select().from(journey).where(eq(journey.id, journeyId)).limit(1);

	if (!record) {
		throw new Error(`Journey ${journeyId} not found`);
	}
	return record;
}

function requiredMounts(record: typeof journey.$inferSelect) {
	const mounts: { kind: string; accessPointArn: string; mountPath: string }[] = [];
	if (record.sourceAccessPointArn) {
		mounts.push({
			kind: "source",
			accessPointArn: record.sourceAccessPointArn,
			mountPath: SOURCE_MOUNT_PATH,
		});
	}
	if (record.targetAccessPointArn) {
		mounts.push({
			kind: "target",
			accessPointArn: record.targetAccessPointArn,
			mountPath: TARGET_MOUNT_PATH,
		});
	}
	return mounts;
}

function checkNetwork(runtime: GetAgentRuntimeCommandOutput): {
	configured: boolean;
	detail: string;
} {
	const { subnetIds } = agentVpcNetwork();
	const config = runtime.networkConfiguration;

	if (config?.networkMode !== "VPC") {
		return {
			configured: false,
			detail: `Runtime uses ${config?.networkMode ?? "unknown"} networking and cannot reach the file system`,
		};
	}

	const runtimeSubnets = config.networkModeConfig?.subnets ?? [];
	const inOurVpc = runtimeSubnets.some((subnet) => subnetIds.includes(subnet));
	if (!inOurVpc) {
		return {
			configured: false,
			detail: "Runtime is in VPC mode but not in the journey VPC subnets",
		};
	}

	return { configured: true, detail: "Runtime is in the journey VPC" };
}

async function checkPermissions(
	record: typeof journey.$inferSelect,
	runtime: GetAgentRuntimeCommandOutput,
): Promise<AgentRuntimeValidation["permissions"]> {
	if (!runtime.roleArn) {
		return {
			configured: false,
			missingActions: [],
			detail: "Runtime has no execution role",
		};
	}

	try {
		const result = await checkAgentPermissions(record, runtime.roleArn);
		return {
			configured: result.configured,
			missingActions: result.missingActions,
			detail: result.configured
				? "Execution role can mount and read the journey data"
				: `Execution role is missing: ${result.missingActions.join(", ")}`,
		};
	} catch (error) {
		return {
			configured: false,
			missingActions: [],
			detail: `Could not simulate role permissions: ${error instanceof Error ? error.message : "unknown error"}`,
		};
	}
}

function checkMounts(
	record: typeof journey.$inferSelect,
	runtime: GetAgentRuntimeCommandOutput,
): { configured: boolean; missingMounts: string[] } {
	const mountedArns = new Set(
		(runtime.filesystemConfigurations ?? [])
			.map((config) => ("s3FilesAccessPoint" in config ? config.s3FilesAccessPoint?.accessPointArn : undefined))
			.filter(Boolean),
	);

	const missingMounts = requiredMounts(record)
		.filter((mount) => !mountedArns.has(mount.accessPointArn))
		.map((mount) => mount.kind);

	return { configured: missingMounts.length === 0, missingMounts };
}

async function validateRuntime(
	record: typeof journey.$inferSelect,
	agentRuntimeId: string,
	agentRuntimeName: string | null,
): Promise<AgentRuntimeValidation> {
	try {
		const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));

		const network = checkNetwork(runtime);
		const mounts = checkMounts(record, runtime);
		const permissions = await checkPermissions(record, runtime);

		return {
			agentRuntimeId,
			agentRuntimeName: runtime.agentRuntimeName ?? agentRuntimeName,
			runtimeStatus: runtime.status ?? null,
			network,
			mounts,
			permissions,
			configured: network.configured && mounts.configured && permissions.configured,
		};
	} catch (error) {
		return {
			agentRuntimeId,
			agentRuntimeName,
			runtimeStatus: null,
			network: { configured: false, detail: "Could not inspect runtime" },
			mounts: { configured: false, missingMounts: [] },
			permissions: {
				configured: false,
				missingActions: [],
				detail: "Could not inspect runtime",
			},
			configured: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Extracts the harness ID from the ValidationException raised when a
 * harness-managed runtime is updated directly, e.g. "This agent runtime is
 * managed by harness 'arn:...:harness/advanced-MoNdlKABau' and cannot be
 * updated directly. Use UpdateHarness to update this resource."
 */
function managingHarnessId(error: unknown): string | null {
	if (!(error instanceof ValidationException)) {
		return null;
	}
	const match = error.message.match(/managed by harness '(?:arn:[^']*:harness\/)?([^'/]+)'/);
	return match?.[1] ?? null;
}

/**
 * Applies an update to a runtime by round-tripping its current configuration
 * with overrides, then waits for the runtime to leave UPDATING so sequential
 * fixes (network first, then mounts) don't race each other.
 *
 * Handles both standalone runtimes (UpdateAgentRuntime) and harness-managed
 * runtimes: if the direct update is rejected because a harness owns the
 * runtime, the same environment change is applied through UpdateHarness.
 */
async function updateRuntime(
	agentRuntimeId: string,
	overrides: {
		networkConfiguration?: NetworkConfiguration;
		filesystemConfigurations?: FilesystemConfiguration[];
	},
) {
	const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
	if (!runtime.agentRuntimeArtifact || !runtime.roleArn) {
		throw new Error("Runtime is missing its artifact or role; cannot update it");
	}

	// requireServiceS3Endpoint is returned by GetAgentRuntime but may only be
	// sent for pre-2026-06-11 runtimes; echoing it back for newer agents fails
	// with a ValidationException. Strip it before updating.
	let networkConfiguration = overrides.networkConfiguration ?? runtime.networkConfiguration;
	if (networkConfiguration?.networkModeConfig) {
		const { requireServiceS3Endpoint: _stripped, ...networkModeConfig } = networkConfiguration.networkModeConfig;
		networkConfiguration = { ...networkConfiguration, networkModeConfig };
	}

	const filesystemConfigurations = overrides.filesystemConfigurations ?? runtime.filesystemConfigurations;

	try {
		await client.send(
			new UpdateAgentRuntimeCommand({
				agentRuntimeId,
				agentRuntimeArtifact: runtime.agentRuntimeArtifact,
				roleArn: runtime.roleArn,
				networkConfiguration,
				protocolConfiguration: runtime.protocolConfiguration,
				environmentVariables: runtime.environmentVariables,
				lifecycleConfiguration: runtime.lifecycleConfiguration,
				authorizerConfiguration: runtime.authorizerConfiguration,
				requestHeaderConfiguration: runtime.requestHeaderConfiguration,
				description: runtime.description,
				filesystemConfigurations,
			}),
		);
	} catch (error) {
		const harnessId = managingHarnessId(error);
		if (!harnessId) {
			throw error;
		}

		// Harness-managed runtime: apply the same environment change through the
		// harness. Only the environment fields are sent; the harness keeps its
		// model/tools/prompt configuration untouched.
		await client.send(
			new UpdateHarnessCommand({
				harnessId,
				environment: {
					agentCoreRuntimeEnvironment: {
						lifecycleConfiguration: runtime.lifecycleConfiguration,
						networkConfiguration,
						filesystemConfigurations,
					},
				},
			}),
		);
	}

	// The runtime doesn't flip to UPDATING synchronously (harness updates in
	// particular propagate asynchronously), so an immediate read can still show
	// READY with the old configuration. Give the transition a moment before the
	// first poll so the validation that follows sees the applied change.
	await new Promise((resolve) => setTimeout(resolve, RUNTIME_POLL_INTERVAL_MS));

	const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
		if (current.status !== "UPDATING") {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, RUNTIME_POLL_INTERVAL_MS));
	}
	// Timed out waiting; validation below will surface the UPDATING status.
}

export type JourneyAgentDetachment = {
	agentRuntimeId: string;
	/** Execution role we saw, so the caller can revoke its inline policy. */
	roleArn: string | null;
	/** Set when this runtime could not be detached; deletion continues anyway. */
	error?: string;
};

/**
 * Removes the journey's access points from every given runtime, the exact
 * inverse of `configureJourneyAgentMounts`. Called before the journey's file
 * system is deleted so runtimes aren't left holding dangling mount
 * configurations.
 *
 * Runs per runtime and never throws: a runtime that has been deleted out from
 * under us, or is owned by a harness we can't update, must not block the
 * journey from being deleted. Failures come back in `error` for the caller to
 * surface as warnings.
 */
export async function detachJourneyMounts(
	record: typeof journey.$inferSelect,
	agentRuntimeIds: string[],
): Promise<JourneyAgentDetachment[]> {
	const journeyArns = new Set(requiredMounts(record).map((mount) => mount.accessPointArn));

	return Promise.all(
		agentRuntimeIds.map(async (agentRuntimeId): Promise<JourneyAgentDetachment> => {
			try {
				const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
				const roleArn = runtime.roleArn ?? null;
				const existing = runtime.filesystemConfigurations ?? [];

				const remaining = existing.filter((config) => {
					if (!("s3FilesAccessPoint" in config) || !config.s3FilesAccessPoint) {
						return true;
					}
					return !journeyArns.has(config.s3FilesAccessPoint.accessPointArn ?? "");
				});

				// Nothing of ours attached: leave the runtime alone rather than
				// pushing a no-op update through it.
				if (remaining.length !== existing.length) {
					await updateRuntime(agentRuntimeId, {
						filesystemConfigurations: remaining,
					});
				}

				return { agentRuntimeId, roleArn };
			} catch (error) {
				return {
					agentRuntimeId,
					roleArn: null,
					error: error instanceof Error ? error.message : "unknown error",
				};
			}
		}),
	);
}

async function assignedAgentName(journeyId: string, agentRuntimeId: string) {
	const [assigned] = await db
		.select()
		.from(journeyAgent)
		.where(and(eq(journeyAgent.journeyId, journeyId), eq(journeyAgent.agentRuntimeId, agentRuntimeId)))
		.limit(1);

	return assigned?.agentRuntimeName ?? null;
}

export const listJourneyAgents = os
	.input(z.object({ journeyId: z.string() }))
	.handler(async ({ input }): Promise<JourneyAgent[]> => {
		return db
			.select()
			.from(journeyAgent)
			.where(eq(journeyAgent.journeyId, input.journeyId))
			.orderBy(asc(journeyAgent.createdAt));
	});

export const assignJourneyAgents = os
	.input(
		z.object({
			journeyId: z.string(),
			agents: z
				.array(
					z.object({
						agentRuntimeId: z.string().min(1),
						agentRuntimeArn: z.string().min(1),
						agentRuntimeName: z.string().optional(),
					}),
				)
				.min(1),
		}),
	)
	.handler(async ({ input }): Promise<JourneyAgent[]> => {
		await getJourneyOrThrow(input.journeyId);

		await db
			.insert(journeyAgent)
			.values(
				input.agents.map((agent) => ({
					id: randomUUID(),
					journeyId: input.journeyId,
					agentRuntimeId: agent.agentRuntimeId,
					agentRuntimeArn: agent.agentRuntimeArn,
					agentRuntimeName: agent.agentRuntimeName ?? null,
				})),
			)
			.onConflictDoNothing();

		return db
			.select()
			.from(journeyAgent)
			.where(eq(journeyAgent.journeyId, input.journeyId))
			.orderBy(asc(journeyAgent.createdAt));
	});

export const unassignJourneyAgent = os
	.input(z.object({ journeyId: z.string(), agentRuntimeId: z.string() }))
	.handler(async ({ input }): Promise<void> => {
		await db
			.delete(journeyAgent)
			.where(and(eq(journeyAgent.journeyId, input.journeyId), eq(journeyAgent.agentRuntimeId, input.agentRuntimeId)));
	});

/** Readiness of the journey's mount targets; a journey without any is trivially ready. */
async function fileSystemStatus(record: typeof journey.$inferSelect): Promise<MountTargetsStatus> {
	const ids = record.mountTargetIds ?? [];
	if (ids.length === 0) {
		return { ready: true, total: 0, available: 0 };
	}
	try {
		return await getMountTargetsStatus(ids);
	} catch (error) {
		return {
			ready: false,
			total: ids.length,
			available: 0,
			error: `Could not inspect mount targets: ${error instanceof Error ? error.message : "unknown error"}`,
		};
	}
}

export const validateJourneyAgents = os
	.input(z.object({ journeyId: z.string() }))
	.handler(async ({ input }): Promise<JourneyAgentsValidation> => {
		const record = await getJourneyOrThrow(input.journeyId);
		const assigned = await db
			.select()
			.from(journeyAgent)
			.where(eq(journeyAgent.journeyId, input.journeyId))
			.orderBy(asc(journeyAgent.createdAt));

		const [fileSystem, agents] = await Promise.all([
			fileSystemStatus(record),
			Promise.all(assigned.map((agent) => validateRuntime(record, agent.agentRuntimeId, agent.agentRuntimeName))),
		]);
		return { fileSystem, agents };
	});

/** Fix 1: move the runtime into the journey VPC (subnets + agent SG). */
export const configureJourneyAgentNetwork = os
	.input(z.object({ journeyId: z.string(), agentRuntimeId: z.string() }))
	.handler(async ({ input }): Promise<AgentRuntimeValidation> => {
		const record = await getJourneyOrThrow(input.journeyId);
		const { subnetIds, securityGroupId } = agentVpcNetwork();

		await updateRuntime(input.agentRuntimeId, {
			networkConfiguration: {
				networkMode: "VPC",
				networkModeConfig: {
					subnets: subnetIds,
					securityGroups: [securityGroupId],
				},
			},
		});

		return validateRuntime(
			record,
			input.agentRuntimeId,
			await assignedAgentName(input.journeyId, input.agentRuntimeId),
		);
	});

/** Fix 2: attach the journey's S3 Files access points to the runtime. */
export const configureJourneyAgentMounts = os
	.input(z.object({ journeyId: z.string(), agentRuntimeId: z.string() }))
	.handler(async ({ input }): Promise<AgentRuntimeValidation> => {
		const record = await getJourneyOrThrow(input.journeyId);
		const mounts = requiredMounts(record);
		if (mounts.length === 0) {
			throw new Error("Journey has no access points to attach");
		}

		// AgentCore rejects the update while the file system's mount targets are
		// still creating (ENI provisioning takes a few minutes after journey
		// creation). Fail fast rather than block the request: the wizard polls
		// `validate` and enables this fix once `fileSystem.ready` is true.
		const fileSystem = await fileSystemStatus(record);
		if (!fileSystem.ready) {
			throw new Error(
				fileSystem.error ??
					`The file system is still provisioning (${fileSystem.available}/${fileSystem.total} mount targets available). It will be attachable in a minute or two.`,
			);
		}

		const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: input.agentRuntimeId }));

		const mountPaths = new Set(mounts.map((mount) => mount.mountPath));
		const journeyArns = new Set(mounts.map((mount) => mount.accessPointArn));

		// Keep existing filesystem configs except s3files entries that collide
		// with the journey's mount paths or duplicate its access points.
		const preserved = (runtime.filesystemConfigurations ?? []).filter((config) => {
			if (!("s3FilesAccessPoint" in config) || !config.s3FilesAccessPoint) {
				return true;
			}
			const { accessPointArn, mountPath } = config.s3FilesAccessPoint;
			return !journeyArns.has(accessPointArn ?? "") && !mountPaths.has(mountPath ?? "");
		});

		await updateRuntime(input.agentRuntimeId, {
			filesystemConfigurations: [
				...preserved,
				...mounts.map((mount) => ({
					s3FilesAccessPoint: {
						accessPointArn: mount.accessPointArn,
						mountPath: mount.mountPath,
					},
				})),
			],
		});

		return validateRuntime(
			record,
			input.agentRuntimeId,
			await assignedAgentName(input.journeyId, input.agentRuntimeId),
		);
	});

/**
 * Fix 3: grant the runtime's execution role the S3 Files client and bucket
 * read permissions via an inline policy on the role.
 */
export const configureJourneyAgentPermissions = os
	.input(z.object({ journeyId: z.string(), agentRuntimeId: z.string() }))
	.handler(async ({ input }): Promise<AgentRuntimeValidation> => {
		const record = await getJourneyOrThrow(input.journeyId);

		const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: input.agentRuntimeId }));
		if (!runtime.roleArn) {
			throw new Error("Runtime has no execution role to grant permissions to");
		}

		await grantAgentPermissions(record, runtime.roleArn);

		return validateRuntime(
			record,
			input.agentRuntimeId,
			await assignedAgentName(input.journeyId, input.agentRuntimeId),
		);
	});
