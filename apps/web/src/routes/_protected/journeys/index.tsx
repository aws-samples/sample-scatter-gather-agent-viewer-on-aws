import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowUpDown,
	Bot,
	FileSearch,
	FolderOpen,
	Map as MapIcon,
	Plus,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { client } from "@/orpc/client";

export const Route = createFileRoute("/_protected/journeys/")({
	staticData: { crumb: "Journeys" },
	loader: () => client.journeys.list({}),
	component: JourneysPage,
});

type SortKey = "name" | "createdAt";

function JourneysPage() {
	const journeys = Route.useLoaderData();
	const [sortBy, setSortBy] = useState<SortKey>("createdAt");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

	const sortedJourneys = [...journeys].sort((a, b) => {
		const compare =
			sortBy === "name"
				? a.name.localeCompare(b.name)
				: new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
		return sortOrder === "asc" ? compare : -compare;
	});

	const handleSort = (key: SortKey) => {
		if (sortBy === key) {
			setSortOrder(sortOrder === "asc" ? "desc" : "asc");
		} else {
			setSortBy(key);
			setSortOrder(key === "createdAt" ? "desc" : "asc");
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="mx-auto w-full max-w-7xl px-2 py-2 md:py-3 lg:px-3">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
					<div>
						<h1 className="text-2xl font-semibold">Journeys</h1>
						<p className="text-muted-foreground text-sm">
							A journey points at the data for one migration and the agents that
							assess it.
						</p>
					</div>
					{journeys.length > 0 && (
						<Button nativeButton={false} render={<Link to="/journeys/new" />}>
							<Plus className="h-4 w-4" />
							Create journey
						</Button>
					)}
				</div>

				{journeys.length === 0 ? (
					<NoJourneys />
				) : (
					<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
						<div className="overflow-x-auto">
							<table className="w-full">
								<thead>
									<tr className="bg-muted/50 border-b">
										<th className="p-4 text-left">
											<Button
												variant="ghost"
												onClick={() => handleSort("name")}
												className="flex h-8 items-center gap-1 font-medium"
											>
												Journey
												<ArrowUpDown className="h-4 w-4" />
											</Button>
										</th>
										<th className="p-4 text-left text-sm font-medium">
											Source
										</th>
										<th className="p-4 text-left text-sm font-medium">
											Target
										</th>
										<th className="p-4 text-left text-sm font-medium">Type</th>
										<th className="p-4 text-left">
											<Button
												variant="ghost"
												onClick={() => handleSort("createdAt")}
												className="flex h-8 items-center gap-1 font-medium"
											>
												Created
												<ArrowUpDown className="h-4 w-4" />
											</Button>
										</th>
										<th className="w-24 p-4"></th>
									</tr>
								</thead>
								<tbody>
									{sortedJourneys.map((journey) => (
										<tr key={journey.id} className="hover:bg-muted/30 border-b">
											<td className="p-4">
												<Link
													to="/journeys/$journeyId"
													params={{ journeyId: journey.id }}
													className="font-medium underline-offset-4 hover:underline"
												>
													{journey.name}
												</Link>
												{journey.description && (
													<p className="text-muted-foreground mt-0.5 max-w-md truncate text-xs">
														{journey.description}
													</p>
												)}
											</td>
											<td className="p-4">
												<code className="bg-secondary text-secondary-foreground rounded-md px-2 py-1 text-xs">
													s3://{journey.bucketName}/{journey.sourcePath}
												</code>
											</td>
											<td className="text-muted-foreground p-4 text-sm">
												{journey.targetPath ? (
													<code className="bg-secondary text-secondary-foreground rounded-md px-2 py-1 text-xs">
														{journey.targetPath}
													</code>
												) : (
													"—"
												)}
											</td>
											<td className="text-muted-foreground p-4 text-sm">
												{journey.migrationType ?? "—"}
											</td>
											<td className="text-muted-foreground p-4 text-sm whitespace-nowrap">
												{new Date(journey.createdAt).toLocaleDateString()}
											</td>
											<td className="p-4">
												<Button
													size="sm"
													className="w-full"
													nativeButton={false}
													render={
														<Link
															to="/journeys/$journeyId"
															params={{ journeyId: journey.id }}
														/>
													}
												>
													View
												</Button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

const STEPS = [
	{
		icon: FolderOpen,
		title: "Point at your data",
		description:
			"Name the S3 bucket and the source path (and optional target path) holding the system to assess.",
	},
	{
		icon: Bot,
		title: "Assign agents",
		description:
			"Pick the AgentCore runtimes that will scan it. The wizard mounts the data read-only and checks their access.",
	},
	{
		icon: FileSearch,
		title: "Run an assessment",
		description:
			"Agents scan in parallel and stream their findings live; the aggregator consolidates them into one report.",
	},
];

function NoJourneys() {
	return (
		<Empty className="from-muted/50 border bg-gradient-to-b to-transparent">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<MapIcon />
				</EmptyMedia>
				<EmptyTitle>No journeys yet</EmptyTitle>
				<EmptyDescription>
					Create your first journey to start assessing a migration. Here is how
					it works:
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="w-full max-w-3xl">
				<ol className="grid gap-3 text-left sm:grid-cols-3">
					{STEPS.map((step, index) => (
						<li
							key={step.title}
							className="bg-card flex flex-col gap-2 rounded-lg border p-4 shadow-sm"
						>
							<div className="flex items-center gap-2">
								<span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
									{index + 1}
								</span>
								<step.icon
									className="text-muted-foreground h-4 w-4"
									aria-hidden
								/>
								<p className="text-sm font-medium">{step.title}</p>
							</div>
							<p className="text-muted-foreground text-xs leading-relaxed">
								{step.description}
							</p>
						</li>
					))}
				</ol>
				<Button
					size="lg"
					className="mt-2"
					nativeButton={false}
					render={<Link to="/journeys/new" />}
				>
					<Plus className="h-4 w-4" />
					Create your first journey
				</Button>
			</EmptyContent>
		</Empty>
	);
}
