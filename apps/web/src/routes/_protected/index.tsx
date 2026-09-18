import { createFileRoute } from "@tanstack/react-router";
import { ChartAreaInteractive } from "#/components/chart-area-interactive";
import { DataTable } from "@/components/data-table";
import { SectionCards } from "@/components/section-cards";
import { client } from "@/orpc/client";

const CARD_WINDOW_DAYS = 30;

export const Route = createFileRoute("/_protected/")({
	staticData: { crumb: "Dashboard" },
	loader: async () => {
		// The chart fetches the full 90 days up front and slices client-side, so
		// its range toggle doesn't trigger another CloudWatch call.
		const [summary, tokens, runtimes] = await Promise.all([
			client.metrics.agentCore({ days: CARD_WINDOW_DAYS }),
			client.metrics.tokens({ days: 90 }),
			client.metrics.runtimes({ days: CARD_WINDOW_DAYS }),
		]);

		return { summary, tokens, runtimes };
	},
	component: Home,
});

function Home() {
	const { summary, tokens, runtimes } = Route.useLoaderData();

	return (
		<div className="flex flex-1 flex-col">
			<div className="@container/main flex flex-1 flex-col gap-2">
				<div className="flex flex-col gap-4 py-2 md:gap-6 md:py-3">
					<SectionCards summary={summary} />
					<div className="px-2 lg:px-3">
						<ChartAreaInteractive usage={tokens} />
					</div>
					<DataTable data={runtimes.rows} days={runtimes.days} />
				</div>
			</div>
		</div>
	);
}
