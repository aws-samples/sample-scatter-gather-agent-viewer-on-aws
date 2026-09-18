/**
 * Assessment orchestration: the scatter-gather run behind
 * `assessments.start`.
 *
 * Scatter — every agent runtime assigned to the journey is invoked in
 * parallel. Each agent reads the migration data from its S3 Files mounts
 * (/mnt/source, /mnt/target) and returns a Markdown scan report, which we
 * persist to the shared aggregator bucket under
 * `assessments/{assessmentId}/reports/{agentRuntimeId}.md`.
 *
 * Gather — once every agent has finished, the aggregator harness runtime is
 * invoked with the report object keys. It reads them back through its
 * `get_report` MCP tool and responds with the consolidated final report,
 * which becomes `assessment.report`.
 *
 * The whole run happens in the background: `startAssessment` records a
 * RUNNING row and returns immediately, and this module flips the row to
 * COMPLETED or FAILED when the run ends.
 */
import { randomUUID } from "node:crypto";
import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommand,
	InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
	BedrockAgentCoreControlClient,
	GetHarnessCommand,
	ListHarnessesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assessment, db, type journey, type journeyAgent } from "@repo/database";
import { eq } from "drizzle-orm";
import { AGGREGATOR_SOURCE, SourceStream, streamsEnvironment } from "./assessment-streams";
import { awsSdkConfig } from "./aws-sdk";
import { SOURCE_MOUNT_PATH, TARGET_MOUNT_PATH } from "./s3files";

const agentCore = new BedrockAgentCoreClient(awsSdkConfig);
const agentCoreControl = new BedrockAgentCoreControlClient(awsSdkConfig);
const s3 = new S3Client(awsSdkConfig);

/** Per-run guard against runs that hang forever on a stuck runtime. */
const AGENT_INVOCATION_TIMEOUT_MS = 15 * 60 * 1000;

export type AssessmentEnvironment = {
	bucketName: string;
	aggregatorRuntimeArn: string;
};

/**
 * Reads the orchestration configuration, throwing a setup error when it is
 * missing. Called by `startAssessment` before the RUNNING row is created so
 * a misconfigured deployment fails the RPC instead of the background run.
 */
export function assessmentEnvironment(): AssessmentEnvironment {
	const bucketName = process.env.AGGREGATOR_BUCKET_NAME;
	const aggregatorRuntimeArn = process.env.AGGREGATOR_RUNTIME_ARN;

	if (!bucketName || !aggregatorRuntimeArn) {
		throw new Error(
			"AGGREGATOR_BUCKET_NAME and AGGREGATOR_RUNTIME_ARN must be set to run assessments. Deploy the latest infra and re-run setup.",
		);
	}
	return { bucketName, aggregatorRuntimeArn };
}

/**
 * Invokes an agent runtime with a prompt and returns its textual response.
 * Mirrors the aggregator gateway's `invoke_sub_agent` tool: the prompt is
 * wrapped in a JSON payload and the response stream is read to a string.
 *
 * Harness-managed runtimes (including our own aggregator) reject
 * InvokeAgentRuntime; those fall back to InvokeHarness against the harness
 * that owns the runtime — the invocation counterpart of the UpdateHarness
 * fallback in the journey-agents router.
 */
async function invokeRuntime(agentRuntimeArn: string, prompt: string, live: SourceStream): Promise<string> {
	try {
		const out = await agentCore.send(
			new InvokeAgentRuntimeCommand({
				agentRuntimeArn,
				payload: new TextEncoder().encode(JSON.stringify({ prompt })),
				contentType: "application/json",
			}),
			{ requestTimeout: AGENT_INVOCATION_TIMEOUT_MS },
		);
		const text = (await out.response?.transformToString())?.trim();
		if (!text) {
			throw new Error("Runtime returned an empty response");
		}
		// Direct runtimes answer in one shot; surface it as a single delta.
		const answer = extractText(text);
		live.emit({ type: "message" });
		live.emit({ type: "delta", text: answer });
		return answer;
	} catch (caught) {
		if (!(caught instanceof Error) || !/managed by a harness/i.test(caught.message)) {
			throw caught;
		}
		const harnessArn = await resolveHarnessArn(agentRuntimeArn);
		return invokeHarness(harnessArn, prompt, live);
	}
}

/** Cache of runtime ARN -> owning harness ARN; the mapping never changes. */
const harnessArnByRuntimeArn = new Map<string, string>();

/**
 * Finds the harness that manages a runtime. The invocation error names no
 * harness (unlike the update error), and GetAgentRuntime carries no owner
 * reference, so the harness list is scanned for the one whose environment
 * points at this runtime.
 */
async function resolveHarnessArn(agentRuntimeArn: string): Promise<string> {
	const cached = harnessArnByRuntimeArn.get(agentRuntimeArn);
	if (cached) {
		return cached;
	}

	let nextToken: string | undefined;
	do {
		const page = await agentCoreControl.send(new ListHarnessesCommand({ nextToken }));
		for (const summary of page.harnesses ?? []) {
			if (!summary.harnessId) {
				continue;
			}
			const detail = await agentCoreControl.send(new GetHarnessCommand({ harnessId: summary.harnessId }));
			const environment = detail.harness?.environment?.agentCoreRuntimeEnvironment;
			if (environment?.agentRuntimeArn === agentRuntimeArn && detail.harness?.arn) {
				harnessArnByRuntimeArn.set(agentRuntimeArn, detail.harness.arn);
				return detail.harness.arn;
			}
		}
		nextToken = page.nextToken;
	} while (nextToken);

	throw new Error(`Runtime ${agentRuntimeArn} is harness-managed but no harness claims it`);
}

/**
 * Invokes a harness with a single user message and gathers its streamed
 * response. The agent loop may emit several assistant messages while it uses
 * tools; the final non-empty message's text is the answer.
 */
async function invokeHarness(harnessArn: string, prompt: string, live: SourceStream): Promise<string> {
	const out = await agentCore.send(
		new InvokeHarnessCommand({
			harnessArn,
			runtimeSessionId: randomUUID(),
			messages: [{ role: "user", content: [{ text: prompt }] }],
		}),
		{ requestTimeout: AGENT_INVOCATION_TIMEOUT_MS },
	);

	let current = "";
	let lastMessage = "";
	try {
		for await (const event of out.stream ?? []) {
			if (event.messageStart) {
				current = "";
				live.emit({ type: "message" });
			} else if (event.contentBlockStart?.start?.toolUse?.name) {
				live.emit({ type: "tool", name: event.contentBlockStart.start.toolUse.name });
			} else if (event.contentBlockDelta?.delta?.text) {
				current += event.contentBlockDelta.delta.text;
				live.emit({ type: "delta", text: event.contentBlockDelta.delta.text });
			} else if (event.messageStop) {
				if (current.trim()) {
					lastMessage = current;
				}
			} else if (event.internalServerException || event.validationException) {
				const failure = event.internalServerException ?? event.validationException;
				throw new Error(failure?.message ?? "Harness invocation failed");
			} else if (event.runtimeClientError) {
				throw new Error(event.runtimeClientError.message ?? "Harness runtime error");
			}
		}
	} catch (caught) {
		// The managed runtime aborts the whole invocation when a model turn
		// hits its output token cap, even though the text streamed so far is a
		// usable (truncated) answer. Keep it instead of losing the run.
		if (isMaxTokensError(caught) && current.trim().length >= MIN_PARTIAL_ANSWER_CHARS) {
			return `${current.trim()}\n\n---\n\n> **Note:** this output was cut off by the model's output token limit and may be incomplete.`;
		}
		throw caught;
	}

	const text = (lastMessage || current).trim();
	if (!text) {
		throw new Error("Harness returned an empty response");
	}
	return text;
}

/** Only salvage a truncated turn when it plausibly contains a real answer. */
const MIN_PARTIAL_ANSWER_CHARS = 2000;

function isMaxTokensError(caught: unknown): boolean {
	return caught instanceof Error && /maximum token limit/i.test(caught.message);
}

/**
 * Agent runtimes are free to answer with plain text or a small JSON envelope
 * ({"result": "..."} and friends). Unwrap the common envelope shapes so the
 * stored reports are Markdown, not JSON strings.
 */
function extractText(raw: string): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string") {
			return parsed;
		}
		if (parsed && typeof parsed === "object") {
			for (const key of ["result", "output", "response", "text", "content"]) {
				const value = (parsed as Record<string, unknown>)[key];
				if (typeof value === "string" && value.trim()) {
					return value;
				}
			}
		}
	} catch {
		// Not JSON — already plain text.
	}
	return raw;
}

function scatterPrompt(record: typeof journey.$inferSelect, agentName: string): string {
	return [
		`You are running a migration assessment scan for journey "${record.name}" as agent "${agentName}".`,
		record.migrationType ? `Migration type: ${record.migrationType}.` : "",
		record.description ? `Journey description: ${record.description}` : "",
		`The migration source data is mounted read-only at ${SOURCE_MOUNT_PATH} (s3://${record.bucketName}/${record.sourcePath}).`,
		record.targetAccessPointArn && record.targetPath
			? `The migration target is mounted read-only at ${TARGET_MOUNT_PATH} (s3://${record.bucketName}/${record.targetPath}).`
			: "",
		"Scan the mounted data from your area of expertise and respond with a complete Markdown scan report: what you inspected, findings, migration risks, and recommendations. Respond with the Markdown report only.",
	]
		.filter(Boolean)
		.join("\n");
}

function gatherPrompt(
	record: typeof journey.$inferSelect,
	reports: { agentName: string; key: string }[],
	failures: { agentName: string; error: string }[],
): string {
	return [
		`All sub-agent scans for migration journey "${record.name}" have finished.`,
		"Read each scan report below with the get_report tool, then respond with the single consolidated Markdown assessment report.",
		// The managed harness runtime caps a model turn at ~4k output tokens
		// and aborts the invocation when the cap is hit, so the report must be
		// written to fit. Be explicit about the budget.
		"Keep the final report under 1500 words: an executive summary, findings merged and de-duplicated across agents ordered by severity (one short paragraph or table row each), risks, and recommended next steps. Do not restate the source reports. Write the entire report in one response.",
		"",
		"Scan reports (agent — S3 object key):",
		...reports.map(({ agentName, key }) => `- ${agentName} — ${key}`),
		...(failures.length > 0
			? [
					"",
					"These agents failed to produce a report; note them in the final report:",
					...failures.map(({ agentName, error }) => `- ${agentName} — ${error}`),
				]
			: []),
	].join("\n");
}

function errorMessage(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Runs the scatter-gather assessment and records the outcome on the
 * assessment row. Never throws: any failure marks the run FAILED.
 */
export async function runAssessment(
	assessmentId: string,
	record: typeof journey.$inferSelect,
	agents: (typeof journeyAgent.$inferSelect)[],
	env: AssessmentEnvironment,
): Promise<void> {
	const streamsEnv = streamsEnvironment();
	// Opened up front (not at gather time) so the assessment page finds every
	// source's stream as soon as it loads instead of polling 404s.
	const aggregatorLive = await SourceStream.open(streamsEnv, assessmentId, AGGREGATOR_SOURCE);
	try {
		// Scatter: run every assigned agent and stage its report in the shared
		// folder. One agent failing doesn't abort the run; the aggregator is told
		// about it instead. Each agent's response is mirrored live to its
		// durable stream for the UI.
		const results = await Promise.all(
			agents.map(async (agent) => {
				const agentName = agent.agentRuntimeName ?? agent.agentRuntimeId;
				const live = await SourceStream.open(streamsEnv, assessmentId, agent.agentRuntimeId);
				try {
					const report = await invokeRuntime(agent.agentRuntimeArn, scatterPrompt(record, agentName), live);
					const key = `assessments/${assessmentId}/reports/${agent.agentRuntimeId}.md`;
					await s3.send(
						new PutObjectCommand({
							Bucket: env.bucketName,
							Key: key,
							Body: report,
							ContentType: "text/markdown",
						}),
					);
					await live.complete();
					return { agentName, key, error: null };
				} catch (caught) {
					await live.failed(errorMessage(caught));
					return { agentName, key: null, error: errorMessage(caught) };
				}
			}),
		);

		const reports = results.filter(
			(result): result is { agentName: string; key: string; error: null } => result.key !== null,
		);
		const failures = results.filter(
			(result): result is { agentName: string; key: null; error: string } => result.error !== null,
		);

		if (reports.length === 0) {
			throw new Error(
				`Every agent failed: ${failures.map(({ agentName, error }) => `${agentName}: ${error}`).join("; ")}`,
			);
		}

		// Gather: the aggregator observes the shared folder and writes the final
		// consolidated report, streamed live to its own stream.
		const finalReport = await invokeRuntime(
			env.aggregatorRuntimeArn,
			gatherPrompt(record, reports, failures),
			aggregatorLive,
		);
		await aggregatorLive.complete();

		await db
			.update(assessment)
			.set({
				status: "COMPLETED",
				report: finalReport,
				completedAt: new Date(),
			})
			.where(eq(assessment.id, assessmentId));
	} catch (caught) {
		console.error(`Assessment ${assessmentId} failed:`, caught);
		// Close the aggregator stream so its panel stops waiting (idempotent if
		// the failure happened after it already closed).
		await aggregatorLive.failed(errorMessage(caught));
		await db
			.update(assessment)
			.set({
				status: "FAILED",
				error: errorMessage(caught),
				completedAt: new Date(),
			})
			.where(eq(assessment.id, assessmentId))
			.catch((updateError) => {
				console.error(`Assessment ${assessmentId}: failed to record failure:`, updateError);
			});
	}
}
