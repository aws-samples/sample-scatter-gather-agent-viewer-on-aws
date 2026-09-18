import type { AgentRuntime, Journey, JourneyAgent } from "@repo/api/router";
import {
	createFileRoute,
	Link,
	notFound,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeft, Bot, Plus, Rocket, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { StartAssessmentWizard } from "@/components/start-assessment-wizard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { JOURNEYS_CRUMB } from "@/lib/breadcrumbs";
import { client } from "@/orpc/client";

export const Route = createFileRoute("/_protected/journeys/$journeyId")({
	staticData: {
		crumb: ({ loaderData, params }) => {
			const data = loaderData as { journey: Journey } | undefined;
			return [
				JOURNEYS_CRUMB,
				data?.journey.name ?? params.journeyId ?? "Journey",
			];
		},
	},
	loader: async ({ params }) => {
		const journey = await client.journeys.get({ id: params.journeyId });
		if (!journey) {
			throw notFound();
		}

		const [agents, assessments, runtimes] = await Promise.all([
			client.journeys.agents.list({ journeyId: journey.id }),
			client.assessments.list({ journeyId: journey.id }),
			client.agents.list({}),
		]);

		return { journey, agents, assessments, runtimes };
	},
	component: JourneyDashboard,
});

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

function SectionCard({
	title,
	action,
	children,
}: {
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="bg-card overflow-hidden rounded-xl border shadow-sm">
			<div className="bg-muted/50 flex items-center justify-between border-b p-4">
				<h2 className="font-medium">{title}</h2>
				{action}
			</div>
			{children}
		</div>
	);
}

function assessmentStatusVariant(status: string) {
	switch (status) {
		case "COMPLETED":
			return "text-green-500";
		case "FAILED":
			return "text-destructive";
		default:
			return "text-orange-500";
	}
}

function AssignAgentsDialog({
	journeyId,
	runtimes,
	assigned,
	open,
	onOpenChange,
}: {
	journeyId: string;
	runtimes: AgentRuntime[];
	assigned: JourneyAgent[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const [selected, setSelected] = useState<string[]>([]);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const assignedIds = new Set(assigned.map((agent) => agent.agentRuntimeId));
	const available = runtimes.filter(
		(runtime) =>
			runtime.agentRuntimeId && !assignedIds.has(runtime.agentRuntimeId),
	);

	const toggle = (id: string) => {
		setSelected((current) =>
			current.includes(id)
				? current.filter((item) => item !== id)
				: [...current, id],
		);
	};

	const save = async () => {
		const agents = available
			.filter((runtime) => selected.includes(runtime.agentRuntimeId ?? ""))
			.map((runtime) => ({
				agentRuntimeId: runtime.agentRuntimeId ?? "",
				agentRuntimeArn: runtime.agentRuntimeArn ?? "",
				agentRuntimeName: runtime.agentRuntimeName,
			}));
		if (agents.length === 0) {
			return;
		}

		setError(null);
		setIsSaving(true);
		try {
			await client.journeys.agents.assign({ journeyId, agents });
			await router.invalidate();
			setSelected([]);
			onOpenChange(false);
		} catch {
			setError("Failed to assign agents. Please try again.");
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Assign agents</DialogTitle>
					<DialogDescription>
						Select the AgentCore runtimes that will work on this journey.
					</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
					{available.length === 0 && (
						<p className="text-muted-foreground py-4 text-center text-sm">
							Every runtime is already assigned to this journey.
						</p>
					)}
					{available.map((runtime) => {
						const id = runtime.agentRuntimeId ?? "";
						return (
							<label
								key={id}
								className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg p-2"
							>
								<Checkbox
									checked={selected.includes(id)}
									onCheckedChange={() => toggle(id)}
									aria-label={`Select ${runtime.agentRuntimeName ?? id}`}
								/>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">
										{runtime.agentRuntimeName ?? id}
									</p>
									<p className="text-muted-foreground truncate text-xs">{id}</p>
								</div>
							</label>
						);
					})}
				</div>
				{error && <p className="text-destructive text-sm">{error}</p>}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={() => void save()}
						disabled={selected.length === 0 || isSaving}
					>
						{isSaving
							? "Assigning…"
							: `Assign ${selected.length || ""} agent${selected.length === 1 ? "" : "s"}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function DeleteJourneyDialog({
	journey,
	agentCount,
	assessmentCount,
	open,
	onOpenChange,
}: {
	journey: Journey;
	agentCount: number;
	assessmentCount: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const navigate = useNavigate();
	const [confirmation, setConfirmation] = useState("");
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Set once the journey is gone but AWS teardown left residue worth reporting.
	const [warnings, setWarnings] = useState<string[] | null>(null);

	const leave = async () => {
		onOpenChange(false);
		// Navigate before invalidating: this route's loader would otherwise re-run
		// against a journey that no longer exists and throw notFound().
		await navigate({ to: "/journeys" });
		await router.invalidate();
	};

	const confirmDelete = async () => {
		setError(null);
		setIsDeleting(true);
		try {
			const result = await client.journeys.delete({ id: journey.id });
			if (result.warnings.length > 0) {
				setWarnings(result.warnings);
				return;
			}
			await leave();
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: "Could not delete the journey. Please try again.",
			);
		} finally {
			setIsDeleting(false);
		}
	};

	if (warnings) {
		return (
			<Dialog open={open} onOpenChange={() => void leave()}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Journey deleted with warnings</DialogTitle>
						<DialogDescription>
							{journey.name} was deleted, but some cleanup did not complete.
							These may need attention in the AWS console.
						</DialogDescription>
					</DialogHeader>
					<ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
						{warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
					<DialogFooter>
						<Button onClick={() => void leave()}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={open} onOpenChange={isDeleting ? undefined : onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete journey</DialogTitle>
					<DialogDescription>
						This permanently deletes {journey.name} and the AWS resources
						provisioned for it. It cannot be undone.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3 text-sm">
					<ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5">
						<li>The S3 Files file system, access points, and mount targets</li>
						<li>
							{agentCount === 0
								? "No agent assignments"
								: `${agentCount} agent assignment${agentCount === 1 ? "" : "s"}, detached from their runtimes first`}
						</li>
						<li>
							{assessmentCount === 0
								? "No assessments"
								: `${assessmentCount} assessment${assessmentCount === 1 ? "" : "s"} and their reports`}
						</li>
					</ul>
					<p className="text-muted-foreground">
						The S3 bucket{" "}
						<span className="font-medium">{journey.bucketName}</span> and its
						objects are not touched.
					</p>
					<div className="flex flex-col gap-2">
						<Label htmlFor="confirm-journey-name">
							Type <span className="font-medium">{journey.name}</span> to
							confirm
						</Label>
						<Input
							id="confirm-journey-name"
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
							placeholder={journey.name}
							autoComplete="off"
							disabled={isDeleting}
						/>
					</div>
					{isDeleting && (
						<p className="text-muted-foreground">
							Tearing down mount targets and the file system. This usually takes
							a minute or two — don't close this tab.
						</p>
					)}
				</div>

				{error && <p className="text-destructive text-sm">{error}</p>}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => void confirmDelete()}
						disabled={confirmation !== journey.name || isDeleting}
					>
						{isDeleting ? "Deleting…" : "Delete journey"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function JourneyDashboard() {
	const { journey, agents, assessments, runtimes } = Route.useLoaderData();
	const router = useRouter();
	const [assignOpen, setAssignOpen] = useState(false);
	const [wizardOpen, setWizardOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [removingId, setRemovingId] = useState<string | null>(null);

	const removeAgent = async (agentRuntimeId: string) => {
		setRemovingId(agentRuntimeId);
		try {
			await client.journeys.agents.unassign({
				journeyId: journey.id,
				agentRuntimeId,
			});
			await router.invalidate();
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="mx-auto w-full max-w-7xl px-2 py-2 md:py-3 lg:px-3">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-3">
						<Button
							variant="ghost"
							size="icon"
							nativeButton={false}
							render={<Link to="/journeys" aria-label="Back to journeys" />}
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
						<div>
							<h1 className="text-2xl font-semibold">{journey.name}</h1>
							{journey.description && (
								<p className="text-muted-foreground text-sm">
									{journey.description}
								</p>
							)}
						</div>
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							onClick={() => setDeleteOpen(true)}
							aria-label={`Delete ${journey.name}`}
						>
							<Trash2 className="h-4 w-4" />
							Delete
						</Button>
						<Button onClick={() => setWizardOpen(true)}>
							<Rocket className="h-4 w-4" />
							Start assessment
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-4">
					<SectionCard title="Journey details">
						<dl>
							<DetailRow label="Bucket">{journey.bucketName}</DetailRow>
							<DetailRow label="Source path">{journey.sourcePath}</DetailRow>
							<DetailRow label="Target path">
								{journey.targetPath ?? "—"}
							</DetailRow>
							<DetailRow label="Migration type">
								{journey.migrationType ?? "—"}
							</DetailRow>
							<DetailRow label="File system">
								{journey.fileSystemId ?? "—"}
							</DetailRow>
							<DetailRow label="Source access point">
								{journey.sourceAccessPointArn ?? "—"}
							</DetailRow>
							{journey.targetAccessPointArn && (
								<DetailRow label="Target access point">
									{journey.targetAccessPointArn}
								</DetailRow>
							)}
							<DetailRow label="Mount targets">
								{journey.mountTargetIds?.join(", ") ?? "—"}
							</DetailRow>
							<DetailRow label="Created">
								{new Date(journey.createdAt).toLocaleString()}
							</DetailRow>
						</dl>
					</SectionCard>

					<SectionCard
						title="Agent allocation"
						action={
							<Button
								size="sm"
								variant="outline"
								onClick={() => setAssignOpen(true)}
							>
								<Plus className="h-4 w-4" />
								Assign agents
							</Button>
						}
					>
						{agents.length === 0 ? (
							<div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
								<Bot className="h-8 w-8 opacity-50" aria-hidden />
								<p>No agents assigned to this journey yet.</p>
							</div>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full">
									<thead>
										<tr className="bg-muted/30 border-b text-left text-sm">
											<th className="p-4 font-medium">Agent</th>
											<th className="p-4 font-medium">Runtime ID</th>
											<th className="p-4 font-medium">Assigned</th>
											<th className="w-16 p-4"></th>
										</tr>
									</thead>
									<tbody>
										{agents.map((agent) => (
											<tr key={agent.id} className="border-b last:border-b-0">
												<td className="p-4 text-sm font-medium">
													{agent.agentRuntimeName ?? agent.agentRuntimeId}
												</td>
												<td className="p-4">
													<span className="bg-secondary text-secondary-foreground inline-block rounded-md px-2 py-1 text-xs font-medium">
														{agent.agentRuntimeId}
													</span>
												</td>
												<td className="text-muted-foreground p-4 text-sm">
													{new Date(agent.createdAt).toLocaleString()}
												</td>
												<td className="p-4">
													<Button
														variant="ghost"
														size="icon"
														aria-label={`Remove ${agent.agentRuntimeName ?? agent.agentRuntimeId}`}
														disabled={removingId === agent.agentRuntimeId}
														onClick={() =>
															void removeAgent(agent.agentRuntimeId)
														}
													>
														<Trash2 className="h-4 w-4" />
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</SectionCard>

					<SectionCard title="Assessments">
						{assessments.length === 0 ? (
							<p className="text-muted-foreground p-8 text-center text-sm">
								No assessments have been run for this journey yet.
							</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full">
									<thead>
										<tr className="bg-muted/30 border-b text-left text-sm">
											<th className="p-4 font-medium">Assessment</th>
											<th className="p-4 font-medium">Status</th>
											<th className="p-4 font-medium">Agents</th>
											<th className="p-4 font-medium">Started</th>
											<th className="p-4 font-medium">Completed</th>
										</tr>
									</thead>
									<tbody>
										{assessments.map((item) => (
											<tr key={item.id} className="border-b last:border-b-0">
												<td className="p-4">
													<Link
														to="/journeys/$journeyId/assessments/$assessmentId"
														params={{
															journeyId: journey.id,
															assessmentId: item.id,
														}}
														className="text-sm font-medium underline-offset-4 hover:underline"
													>
														{item.id.slice(0, 8)}
													</Link>
												</td>
												<td className="p-4">
													<Badge variant="outline">
														<span
															className={assessmentStatusVariant(item.status)}
														>
															{item.status}
														</span>
													</Badge>
												</td>
												<td className="text-muted-foreground p-4 text-sm">
													{item.agentRuntimeIds.length}
												</td>
												<td className="text-muted-foreground p-4 text-sm">
													{new Date(item.startedAt).toLocaleString()}
												</td>
												<td className="text-muted-foreground p-4 text-sm">
													{item.completedAt
														? new Date(item.completedAt).toLocaleString()
														: "—"}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</SectionCard>
				</div>
			</div>

			<AssignAgentsDialog
				journeyId={journey.id}
				runtimes={runtimes}
				assigned={agents}
				open={assignOpen}
				onOpenChange={setAssignOpen}
			/>
			<StartAssessmentWizard
				journey={journey}
				agents={agents}
				runtimes={runtimes}
				open={wizardOpen}
				onOpenChange={setWizardOpen}
			/>
			<DeleteJourneyDialog
				journey={journey}
				agentCount={agents.length}
				assessmentCount={assessments.length}
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
			/>
		</div>
	);
}
