import type { GetAgentRuntimeCommandOutput } from "@repo/api/router";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AGENTS_CRUMB } from "@/lib/breadcrumbs";
import { client } from "@/orpc/client";

export const Route = createFileRoute("/_protected/agents/$agentId")({
	staticData: {
		crumb: ({ loaderData, params }) => {
			const data = loaderData as
				| { runtime: GetAgentRuntimeCommandOutput }
				| undefined;
			return [
				AGENTS_CRUMB,
				data?.runtime.agentRuntimeName ?? params.agentId ?? "Agent",
			];
		},
	},
	loader: async ({
		params,
	}): Promise<{ runtime: GetAgentRuntimeCommandOutput }> => {
		const runtime = await client.agents.get({
			agentRuntimeId: params.agentId,
		});

		if (!runtime) {
			throw notFound();
		}

		return { runtime };
	},
	component: AgentDetailPage,
});

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

function DetailRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1 border-b p-4 last:border-b-0 sm:flex-row sm:items-baseline">
			<dt className="text-muted-foreground w-48 shrink-0 text-sm font-medium break-all sm:w-64">
				{label}
			</dt>
			<dd className="min-w-0 text-sm break-all">{children}</dd>
		</div>
	);
}

function AgentDetailPage() {
	const { runtime } = Route.useLoaderData();

	const containerUri =
		runtime.agentRuntimeArtifact?.containerConfiguration?.containerUri;
	const environmentVariables = Object.entries(
		runtime.environmentVariables ?? {},
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="mx-auto w-full max-w-7xl px-2 py-2 md:py-3 lg:px-3">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-3">
						<Button
							variant="ghost"
							size="icon"
							nativeButton={false}
							render={<Link to="/agents" aria-label="Back to agents" />}
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
						<div>
							<h1 className="text-2xl font-semibold">
								{runtime.agentRuntimeName ?? runtime.agentRuntimeId}
							</h1>
							{runtime.description && (
								<p className="text-muted-foreground text-sm">
									{runtime.description}
								</p>
							)}
						</div>
					</div>
					<span
						className={`text-sm font-medium ${statusColor(runtime.status)}`}
					>
						{runtime.status ?? "UNKNOWN"}
					</span>
				</div>

				<div className="flex flex-col gap-4">
					<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
						<h2 className="bg-muted/50 border-b p-4 font-medium">Overview</h2>
						<dl>
							<DetailRow label="Runtime ID">
								{runtime.agentRuntimeId ?? "—"}
							</DetailRow>
							<DetailRow label="ARN">
								{runtime.agentRuntimeArn ?? "—"}
							</DetailRow>
							<DetailRow label="Version">
								{runtime.agentRuntimeVersion ?? "—"}
							</DetailRow>
							<DetailRow label="Created">
								{runtime.createdAt
									? new Date(runtime.createdAt).toLocaleString()
									: "—"}
							</DetailRow>
							<DetailRow label="Last updated">
								{runtime.lastUpdatedAt
									? new Date(runtime.lastUpdatedAt).toLocaleString()
									: "—"}
							</DetailRow>
							{runtime.failureReason && (
								<DetailRow label="Failure reason">
									<span className="text-destructive">
										{runtime.failureReason}
									</span>
								</DetailRow>
							)}
						</dl>
					</div>

					<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
						<h2 className="bg-muted/50 border-b p-4 font-medium">
							Configuration
						</h2>
						<dl>
							<DetailRow label="Execution role">
								{runtime.roleArn ?? "—"}
							</DetailRow>
							<DetailRow label="Container image">
								{containerUri ?? "—"}
							</DetailRow>
							<DetailRow label="Network mode">
								{runtime.networkConfiguration?.networkMode ?? "—"}
							</DetailRow>
							<DetailRow label="Protocol">
								{runtime.protocolConfiguration?.serverProtocol ?? "—"}
							</DetailRow>
							{runtime.workloadIdentityDetails?.workloadIdentityArn && (
								<DetailRow label="Workload identity">
									{runtime.workloadIdentityDetails.workloadIdentityArn}
								</DetailRow>
							)}
						</dl>
					</div>

					{environmentVariables.length > 0 && (
						<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
							<h2 className="bg-muted/50 border-b p-4 font-medium">
								Environment variables
							</h2>
							<dl>
								{environmentVariables.map(([key, value]) => (
									<DetailRow key={key} label={key}>
										<code className="bg-muted rounded px-1.5 py-0.5 text-xs">
											{value}
										</code>
									</DetailRow>
								))}
							</dl>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
