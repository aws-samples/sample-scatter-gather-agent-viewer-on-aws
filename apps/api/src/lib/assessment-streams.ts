/**
 * Live assessment output on Durable Streams (https://durablestreams.com).
 *
 * Every source in a run — each sub-agent and the aggregator — gets its own
 * append-only JSON stream at `assessments/{assessmentId}/{source}`. The run
 * appends events as the agent's response streams in; browsers tail the same
 * streams (via the ALB -> Durable Streams server, session-checked by Caddy
 * forward_auth) and can resume from any offset after a disconnect or reload.
 *
 * The stream is a live view, not the system of record: the sub-agent report
 * still goes to S3 and the final report to Postgres when the run finishes.
 */
import { DurableStream, StreamClosedError } from "@durable-streams/client";

/** Wire format of one stream message. Kept small; the browser renders these. */
export type AssessmentStreamEvent =
	| { type: "started"; at: string }
	/** Start of an assistant message. Harness runs emit several (tool call turns, then the answer). */
	| { type: "message" }
	| { type: "delta"; text: string }
	| { type: "tool"; name: string }
	| { type: "completed"; at: string }
	| { type: "failed"; at: string; error: string };

/** Well-known source for the gather step; sub-agent sources are their runtime IDs. */
export const AGGREGATOR_SOURCE = "aggregator";

/** Streams linger after a run so a late visitor can still replay it. */
const STREAM_TTL_SECONDS = 7 * 24 * 60 * 60;

export type StreamsEnvironment = {
	baseUrl: string;
	writerToken: string;
};

/**
 * Optional: when unset, runs proceed without live output. Deployed by the
 * CDK stack; local dev points at the docker-compose service.
 */
export function streamsEnvironment(): StreamsEnvironment | null {
	const baseUrl = process.env.DURABLE_STREAMS_URL?.replace(/\/+$/, "");
	const writerToken = process.env.DURABLE_STREAMS_WRITER_TOKEN;
	if (!baseUrl || !writerToken) {
		return null;
	}
	return { baseUrl, writerToken };
}

export function streamPath(assessmentId: string, source: string): string {
	return `assessments/${assessmentId}/${source}`;
}

/**
 * Writer for one source's stream. Best-effort by design: the stream is a
 * viewing aid, so a streams outage must never fail an assessment run. Errors
 * are logged once and the writer goes quiet.
 */
export class SourceStream {
	private handle: DurableStream | null = null;
	private pending: Promise<unknown> = Promise.resolve();
	private broken = false;

	private constructor(
		private readonly path: string,
		private readonly env: StreamsEnvironment,
	) {}

	static async open(env: StreamsEnvironment | null, assessmentId: string, source: string): Promise<SourceStream> {
		const path = streamPath(assessmentId, source);
		const stream = new SourceStream(path, env ?? { baseUrl: "", writerToken: "" });
		if (!env) {
			stream.broken = true;
			return stream;
		}
		try {
			stream.handle = await DurableStream.create({
				url: `${env.baseUrl}/${path}`,
				headers: { Authorization: `Bearer ${env.writerToken}` },
				contentType: "application/json",
				ttlSeconds: STREAM_TTL_SECONDS,
			});
			stream.emit({ type: "started", at: new Date().toISOString() });
		} catch (caught) {
			stream.fail("create", caught);
		}
		return stream;
	}

	/** Fire-and-forget append; the client batches overlapping calls into one POST. */
	emit(event: AssessmentStreamEvent): void {
		if (this.broken || !this.handle) {
			return;
		}
		const append = this.handle.append(JSON.stringify(event)).catch((caught) => this.fail("append", caught));
		this.pending = this.pending.then(() => append);
	}

	/** Terminal event plus EOF, so tailing readers stop instead of waiting forever. */
	async complete(): Promise<void> {
		await this.finish({ type: "completed", at: new Date().toISOString() });
	}

	async failed(error: string): Promise<void> {
		await this.finish({ type: "failed", at: new Date().toISOString(), error });
	}

	private async finish(event: AssessmentStreamEvent): Promise<void> {
		if (this.broken || !this.handle) {
			return;
		}
		try {
			await this.pending;
			await this.handle.close({ body: JSON.stringify(event) });
		} catch (caught) {
			if (!(caught instanceof StreamClosedError)) {
				this.fail("close", caught);
			}
		}
	}

	private fail(operation: string, caught: unknown): void {
		if (!this.broken) {
			this.broken = true;
			console.warn(
				`Durable stream ${this.path}: ${operation} failed, live output disabled for this source:`,
				caught instanceof Error ? caught.message : caught,
			);
		}
	}
}
