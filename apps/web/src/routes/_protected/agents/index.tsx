import type { AgentRuntime } from "@repo/api/router";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { client } from "@/orpc/client";

export const Route = createFileRoute("/_protected/agents/")({
	staticData: { crumb: "Agents" },
	loader: () => client.agents.list({}),
	component: AgentsPage,
});

type SortKey =
	| "agentRuntimeName"
	| "status"
	| "agentRuntimeVersion"
	| "lastUpdatedAt";

function statusColor(status: string | undefined) {
	switch (status) {
		case "READY":
			return "text-green-500";
		case "CREATE_FAILED":
		case "UPDATE_FAILED":
		case "DELETING":
			return "text-destructive";
		default:
			return "text-orange-500";
	}
}

function AgentsPage() {
	const runtimes = Route.useLoaderData();
	const [sortBy, setSortBy] = useState<SortKey>("agentRuntimeName");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
	const [selectedItems, setSelectedItems] = useState<string[]>([]);

	const runtimeKey = (runtime: AgentRuntime) =>
		runtime.agentRuntimeId ?? runtime.agentRuntimeArn ?? "";

	const sortedRuntimes = [...runtimes].sort((a, b) => {
		const aValue = a[sortBy];
		const bValue = b[sortBy];
		if (aValue === undefined) return 1;
		if (bValue === undefined) return -1;
		const compare =
			aValue instanceof Date && bValue instanceof Date
				? aValue.getTime() - bValue.getTime()
				: String(aValue).localeCompare(String(bValue));
		return sortOrder === "asc" ? compare : -compare;
	});

	const handleSort = (key: SortKey) => {
		if (sortBy === key) {
			setSortOrder(sortOrder === "asc" ? "desc" : "asc");
		} else {
			setSortBy(key);
			setSortOrder("asc");
		}
	};

	const handleSelectAll = () => {
		if (selectedItems.length === runtimes.length) {
			setSelectedItems([]);
		} else {
			setSelectedItems(runtimes.map(runtimeKey));
		}
	};

	const handleSelect = (id: string) => {
		if (selectedItems.includes(id)) {
			setSelectedItems(selectedItems.filter((i) => i !== id));
		} else {
			setSelectedItems([...selectedItems, id]);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="mx-auto w-full max-w-7xl px-2 py-2 md:py-3 lg:px-3">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
					<div>
						<h1 className="text-2xl font-semibold">Agents</h1>
						<p className="text-muted-foreground text-sm">
							To create an agent, follow the Amazon Bedrock AgentCore getting
							started guide.
						</p>
					</div>
					<Button
						nativeButton={false}
						render={
							// biome-ignore lint/a11y/useAnchorContent: content comes from Button children via base-ui render
							<a
								href="https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-get-started-cli.html#agentcore-cli-install"
								target="_blank"
								rel="noopener noreferrer"
							/>
						}
					>
						Create an agent
						<ExternalLink className="h-4 w-4" />
					</Button>
				</div>
				<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
					<div className="overflow-x-auto">
						<table className="w-full">
							<thead>
								<tr className="bg-muted/50 border-b">
									<th className="w-12 p-4">
										<Checkbox
											checked={
												runtimes.length > 0 &&
												selectedItems.length === runtimes.length
											}
											onCheckedChange={handleSelectAll}
											aria-label="Select all"
										/>
									</th>
									<th className="p-4 text-left">
										<Button
											variant="ghost"
											onClick={() => handleSort("agentRuntimeName")}
											className="flex h-8 items-center gap-1 font-medium"
										>
											Agent
											<ArrowUpDown className="h-4 w-4" />
										</Button>
									</th>
									<th className="p-4">
										<Button
											variant="ghost"
											onClick={() => handleSort("agentRuntimeVersion")}
											className="flex h-8 items-center gap-1 font-medium"
										>
											Version
											<ArrowUpDown className="h-4 w-4" />
										</Button>
									</th>
									<th className="p-4">
										<Button
											variant="ghost"
											onClick={() => handleSort("status")}
											className="flex h-8 items-center gap-1 font-medium"
										>
											Status
											<ArrowUpDown className="h-4 w-4" />
										</Button>
									</th>
									<th className="p-4">
										<Button
											variant="ghost"
											onClick={() => handleSort("lastUpdatedAt")}
											className="flex h-8 items-center gap-1 font-medium"
										>
											Last updated
											<ArrowUpDown className="h-4 w-4" />
										</Button>
									</th>
								</tr>
							</thead>
							<tbody>
								{sortedRuntimes.length === 0 && (
									<tr>
										<td
											colSpan={5}
											className="text-muted-foreground p-8 text-center text-sm"
										>
											No agent runtimes found. Use the guide above to create
											your first agent.
										</td>
									</tr>
								)}
								{sortedRuntimes.map((runtime) => (
									<tr key={runtimeKey(runtime)} className="border-b">
										<td className="p-4">
											<Checkbox
												checked={selectedItems.includes(runtimeKey(runtime))}
												onCheckedChange={() =>
													handleSelect(runtimeKey(runtime))
												}
												aria-label={`Select ${runtime.agentRuntimeName ?? runtimeKey(runtime)}`}
											/>
										</td>
										<td className="p-4">
											{runtime.agentRuntimeId ? (
												<Link
													to="/agents/$agentId"
													params={{ agentId: runtime.agentRuntimeId }}
													className="font-medium underline-offset-4 hover:underline"
												>
													{runtime.agentRuntimeName ?? "—"}
												</Link>
											) : (
												<div className="font-medium">
													{runtime.agentRuntimeName ?? "—"}
												</div>
											)}
											<div className="text-muted-foreground text-sm">
												{runtime.description || runtime.agentRuntimeId}
											</div>
										</td>
										<td className="p-4 text-center">
											<span className="bg-secondary text-secondary-foreground inline-block rounded-md px-2 py-1 text-xs font-medium">
												v{runtime.agentRuntimeVersion ?? "?"}
											</span>
										</td>
										<td className="p-4 text-center">
											<span
												className={`text-sm font-medium ${statusColor(runtime.status)}`}
											>
												{runtime.status ?? "UNKNOWN"}
											</span>
										</td>
										<td className="p-4 text-center">
											<span className="text-muted-foreground text-sm">
												{runtime.lastUpdatedAt
													? new Date(runtime.lastUpdatedAt).toLocaleString()
													: "—"}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</div>
		</div>
	);
}
