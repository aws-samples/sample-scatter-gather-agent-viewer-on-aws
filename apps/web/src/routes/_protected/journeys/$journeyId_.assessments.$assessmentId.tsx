import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { AssessmentLiveStream } from "@/components/assessment-live-stream";
import { MarkdownReport } from "@/components/markdown-report";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JOURNEYS_CRUMB } from "@/lib/breadcrumbs";
import { client } from "@/orpc/client";

export const Route = createFileRoute(
	"/_protected/journeys/$journeyId_/assessments/$assessmentId",
)({
	staticData: {
		// `$journeyId_` opts out of the journey detail layout, so the journey isn't
		// in this route's match chain and its name isn't in this loader's data.
		crumb: ({ params }) => [
			JOURNEYS_CRUMB,
			{ label: "Journey", href: `/journeys/${params.journeyId ?? ""}` },
			`Assessment ${(params.assessmentId ?? "").slice(0, 8)}`,
		],
	},
	loader: async ({ params }) => {
		const assessment = await client.assessments.get({
			id: params.assessmentId,
		});
		if (!assessment || assessment.journeyId !== params.journeyId) {
			throw notFound();
		}
		return { assessment };
	},
	component: AssessmentPage,
});

function statusColor(status: string) {
	switch (status) {
		case "COMPLETED":
			return "text-green-500";
		case "FAILED":
			return "text-destructive";
		default:
			return "text-orange-500";
	}
}

const POLL_INTERVAL_MS = 5000;

function AssessmentPage() {
	const { assessment } = Route.useLoaderData();
	const { journeyId } = Route.useParams();
	const router = useRouter();

	// The run continues in the background on the API; refresh until it ends.
	const isRunning = assessment.status === "RUNNING";
	useEffect(() => {
		if (!isRunning) {
			return;
		}
		const interval = setInterval(() => {
			void router.invalidate();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [isRunning, router]);

	return (
		<div className="flex flex-col gap-4">
			<div className="mx-auto w-full max-w-4xl px-2 py-2 md:py-3 lg:px-3">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-3">
						<Button
							variant="ghost"
							size="icon"
							nativeButton={false}
							render={
								<Link
									to="/journeys/$journeyId"
									params={{ journeyId }}
									aria-label="Back to journey"
								/>
							}
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
						<div>
							<h1 className="text-2xl font-semibold">
								Assessment {assessment.id.slice(0, 8)}
							</h1>
							<p className="text-muted-foreground text-sm">
								Started {new Date(assessment.startedAt).toLocaleString()}
								{assessment.completedAt &&
									` · Completed ${new Date(assessment.completedAt).toLocaleString()}`}
							</p>
						</div>
					</div>
					<Badge variant="outline">
						<span className={statusColor(assessment.status)}>
							{assessment.status}
						</span>
					</Badge>
				</div>

				<div className="flex flex-col gap-4">
					<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
						<h2 className="bg-muted/50 border-b p-4 font-medium">Agents</h2>
						<div className="flex flex-wrap gap-2 p-4">
							{assessment.agentRuntimeIds.map((id) => (
								<span
									key={id}
									className="bg-secondary text-secondary-foreground inline-block rounded-md px-2 py-1 text-xs font-medium"
								>
									{id}
								</span>
							))}
						</div>
					</div>

					<section className="flex flex-col gap-3">
						<h2 className="px-1 font-medium">Live output</h2>
						{assessment.agentRuntimeIds.map((agentRuntimeId) => (
							<AssessmentLiveStream
								key={agentRuntimeId}
								assessmentId={assessment.id}
								source={agentRuntimeId}
								title={`Agent · ${agentRuntimeId}`}
								running={isRunning}
							/>
						))}
						<AssessmentLiveStream
							assessmentId={assessment.id}
							source="aggregator"
							title="Aggregator · consolidated report"
							running={isRunning}
						/>
					</section>

					{assessment.status === "FAILED" && assessment.error && (
						<div className="border-destructive/50 bg-destructive/10 rounded-xl border p-4">
							<p className="text-destructive text-sm font-medium">
								Assessment failed
							</p>
							<p className="text-destructive/90 mt-1 text-sm break-words">
								{assessment.error}
							</p>
						</div>
					)}

					<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
						<h2 className="bg-muted/50 border-b p-4 font-medium">Report</h2>
						{assessment.report ? (
							<MarkdownReport markdown={assessment.report} className="p-4" />
						) : isRunning ? (
							<div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm">
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
								Agents are scanning the migration data. The report will appear
								here when the aggregator finishes.
							</div>
						) : (
							<p className="text-muted-foreground p-8 text-center text-sm">
								No report is available yet.
							</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
