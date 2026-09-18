import { getAgentRuntime, listAgentRuntimes } from "./agents";
import { getAssessment, listAssessments, startAssessment } from "./assessments";
import {
	assignJourneyAgents,
	configureJourneyAgentMounts,
	configureJourneyAgentNetwork,
	configureJourneyAgentPermissions,
	listJourneyAgents,
	unassignJourneyAgent,
	validateJourneyAgents,
} from "./journey-agents";
import {
	checkJourneyBucket,
	checkJourneyPath,
	createJourney,
	deleteJourney,
	getJourney,
	listJourneyBuckets,
	listJourneyFolders,
	listJourneys,
	prepareJourneyBucket,
} from "./journeys";
import { getAgentCoreSummary, getRuntimeMetrics, getTokenUsage } from "./metrics";

export type {
	AgentRuntime,
	GetAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore-control";
export type { AssessmentStreamEvent } from "../../lib/assessment-streams";
export type { BucketReadiness, BucketSummary, PathCheck } from "../../lib/journey-bucket";
export type { MountTargetsStatus } from "../../lib/s3files";
export type { Assessment } from "./assessments";
export type { AgentRuntimeValidation, JourneyAgent, JourneyAgentsValidation } from "./journey-agents";
export type { Journey, JourneyDeletion } from "./journeys";
export type {
	AgentCoreStat,
	AgentCoreSummary,
	MetricRange,
	RuntimeMetricRow,
	RuntimeMetrics,
	RuntimeTrendPoint,
	TokenUsage,
	TokenUsagePoint,
} from "./metrics";

// Procedures are grouped by resource. The nesting here is what defines the
// RPC path (`journeys.agents.assign` -> `/rpc/journeys/agents/assign`), so
// renaming or moving a key is a wire-level change: deploy api and web together.
export default {
	journeys: {
		list: listJourneys,
		get: getJourney,
		create: createJourney,
		delete: deleteJourney,
		listBuckets: listJourneyBuckets,
		checkBucket: checkJourneyBucket,
		prepareBucket: prepareJourneyBucket,
		listFolders: listJourneyFolders,
		checkPath: checkJourneyPath,

		// Agents assigned to a journey, as opposed to the `agents` namespace
		// below, which lists the AgentCore runtimes available in the account.
		agents: {
			list: listJourneyAgents,
			assign: assignJourneyAgents,
			unassign: unassignJourneyAgent,
			validate: validateJourneyAgents,
			configureNetwork: configureJourneyAgentNetwork,
			configureMounts: configureJourneyAgentMounts,
			configurePermissions: configureJourneyAgentPermissions,
		},
	},

	assessments: {
		list: listAssessments,
		get: getAssessment,
		start: startAssessment,
	},

	agents: {
		list: listAgentRuntimes,
		get: getAgentRuntime,
	},

	// CloudWatch-backed dashboard figures.
	metrics: {
		agentCore: getAgentCoreSummary,
		tokens: getTokenUsage,
		runtimes: getRuntimeMetrics,
	},
};
