import { FetchError, stream } from "@durable-streams/client";
import type { AssessmentStreamEvent } from "@repo/api/router";
import {
	CheckCircle2,
	ChevronDown,
	Loader2,
	Wrench,
	XCircle,
} from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Live view of one assessment source (a sub-agent or the aggregator).
 *
 * Tails the durable stream at /sync/assessments/{assessmentId}/{source}:
 * same-origin, so the Better Auth session cookie authenticates the read
 * (Caddy forward_auth on the streams server). Catch-up and live are the same
 * read, so reloading mid-run replays everything and continues streaming, and
 * finished runs replay until the stream's TTL expires.
 */

type Block = { kind: "text"; text: string } | { kind: "tool"; name: string };

type StreamState = {
	blocks: Block[];
	/** waiting: stream not created yet (run hasn't reached this source). */
	phase: "waiting" | "streaming" | "completed" | "failed" | "unavailable";
	error: string | null;
};

type Action =
	| { type: "events"; events: readonly AssessmentStreamEvent[] }
	| { type: "unavailable" };

function reduce(state: StreamState, action: Action): StreamState {
	if (action.type === "unavailable") {
		return { ...state, phase: "unavailable" };
	}

	let { blocks, phase, error } = state;
	blocks = [...blocks];
	for (const event of action.events) {
		switch (event.type) {
			case "started":
				phase = "streaming";
				break;
			case "message":
				blocks.push({ kind: "text", text: "" });
				break;
			case "tool":
				blocks.push({ kind: "tool", name: event.name });
				break;
			case "delta": {
				const last = blocks[blocks.length - 1];
				if (last?.kind === "text") {
					blocks[blocks.length - 1] = {
						kind: "text",
						text: last.text + event.text,
					};
				} else {
					blocks.push({ kind: "text", text: event.text });
				}
				break;
			}
			case "completed":
				phase = "completed";
				break;
			case "failed":
				phase = "failed";
				error = event.error;
				break;
		}
	}
	return { blocks, phase, error };
}

/** Poll interval while a running assessment hasn't created this stream yet. */
const RETRY_MISSING_STREAM_MS = 3000;

const INITIAL_STATE: StreamState = {
	blocks: [],
	phase: "waiting",
	error: null,
};

export function AssessmentLiveStream({
	assessmentId,
	source,
	title,
	running,
}: {
	assessmentId: string;
	source: string;
	title: string;
	/** Whether the assessment row is still RUNNING (drives 404 handling). */
	running: boolean;
}) {
	const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
	const scrollRef = useRef<HTMLDivElement>(null);
	// Read once per mount; a finished assessment's stream replays identically.
	const runningRef = useRef(running);

	useEffect(() => {
		const controller = new AbortController();

		void stream<AssessmentStreamEvent>({
			url: `${window.location.origin}/sync/assessments/${assessmentId}/${source}`,
			signal: controller.signal,
			live: true,
			onError: async (error) => {
				if (error instanceof FetchError && error.status === 404) {
					// The run creates its streams just after the RPC returns, so a
					// 404 while the assessment is running only means we got here
					// first: retry politely. Afterwards it means no live output was
					// recorded (or the stream expired).
					if (runningRef.current) {
						await new Promise((resolve) =>
							setTimeout(resolve, RETRY_MISSING_STREAM_MS),
						);
						return {};
					}
					dispatch({ type: "unavailable" });
				}
				// Anything else: stop quietly; the panel keeps whatever it has.
				controller.abort();
			},
		}).then((res) => {
			res.subscribeJson((batch) => {
				dispatch({ type: "events", events: batch.items });
			});
		});

		return () => controller.abort("unmounted");
	}, [assessmentId, source]);

	// Follow the tail while text is coming in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new block
	useEffect(() => {
		const el = scrollRef.current;
		if (el && state.phase === "streaming") {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.blocks, state.phase]);

	return (
		<Collapsible
			defaultOpen={running}
			className="bg-card overflow-hidden rounded-xl border shadow-sm"
		>
			<CollapsibleTrigger className="bg-muted/50 group flex w-full cursor-pointer items-center justify-between gap-2 p-4 text-left">
				<h3 className="min-w-0 truncate text-sm font-medium">{title}</h3>
				<span className="flex shrink-0 items-center gap-3">
					<StreamPhaseBadge phase={state.phase} />
					<ChevronDown
						className="text-muted-foreground h-4 w-4 transition-transform group-data-[panel-open]:rotate-180"
						aria-hidden
					/>
				</span>
			</CollapsibleTrigger>

			<CollapsibleContent>
				<div className="border-t">
					{state.error && (
						<p className="text-destructive border-b p-3 text-xs break-words">
							{state.error}
						</p>
					)}

					{state.blocks.length > 0 ? (
						<div ref={scrollRef} className="max-h-80 overflow-y-auto p-4">
							<div className="flex flex-col gap-2">
								{state.blocks.map((block, index) =>
									block.kind === "tool" ? (
										<span
											// biome-ignore lint/suspicious/noArrayIndexKey: append-only list
											key={index}
											className="bg-secondary text-secondary-foreground inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs"
										>
											<Wrench className="h-3 w-3" aria-hidden />
											{block.name}
										</span>
									) : (
										block.text.trim() && (
											<pre
												// biome-ignore lint/suspicious/noArrayIndexKey: append-only list
												key={index}
												className="font-mono text-xs whitespace-pre-wrap"
											>
												{block.text}
											</pre>
										)
									),
								)}
							</div>
						</div>
					) : (
						<p className="text-muted-foreground p-6 text-center text-sm">
							{state.phase === "unavailable"
								? "No live output was recorded for this source."
								: state.phase === "waiting"
									? "Waiting for output…"
									: "No output."}
						</p>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function StreamPhaseBadge({ phase }: { phase: StreamState["phase"] }) {
	switch (phase) {
		case "completed":
			return (
				<span className="flex shrink-0 items-center gap-1 text-xs text-green-500">
					<CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Done
				</span>
			);
		case "failed":
			return (
				<span className="text-destructive flex shrink-0 items-center gap-1 text-xs">
					<XCircle className="h-3.5 w-3.5" aria-hidden /> Failed
				</span>
			);
		case "streaming":
		case "waiting":
			return (
				<span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
					<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
					{phase === "streaming" ? "Streaming" : "Waiting"}
				</span>
			);
		default:
			return null;
	}
}
