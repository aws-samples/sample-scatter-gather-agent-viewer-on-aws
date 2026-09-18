import type {
	AgentRuntime,
	AgentRuntimeValidation,
	Journey,
	JourneyAgent,
	JourneyAgentsValidation,
} from "@repo/api/router";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
	Bot,
	CheckCircle2,
	HardDrive,
	Loader2,
	RefreshCw,
	Rocket,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Stepper } from "@/components/ui/stepper";
import { client } from "@/orpc/client";

const STEPS = [
	{ title: "Assign agents", icon: Bot },
	{ title: "Validate", icon: ShieldCheck },
	{ title: "Launch", icon: Rocket },
];

/**
 * How often to re-validate while something is still settling: mount targets
 * provisioning after journey creation, or a runtime mid-update. Replaces the
 * old server-side wait, which blocked the request and raced its own timeout.
 */
const POLL_INTERVAL_MS = 5000;

type Fix = "network" | "permissions" | "mounts";

const FIXES: Record<
	Fix,
	{ run: typeof client.journeys.agents.configureNetwork; fallback: string }
> = {
	network: {
		run: client.journeys.agents.configureNetwork,
		fallback:
			"Could not move the runtime into the journey VPC. Please try again.",
	},
	permissions: {
		run: client.journeys.agents.configurePermissions,
		fallback: "Could not update the execution role. Please try again.",
	},
	mounts: {
		run: client.journeys.agents.configureMounts,
		fallback:
			"Could not attach the file system to the runtime. Please try again.",
	},
};

/**
 * Attaching mounts needs the runtime in the VPC, the role able to describe the
 * access points, and the file system's mount targets available. Network and
 * IAM are independent of each other and of the file system.
 */
function mountsBlockedBy(
	item: AgentRuntimeValidation,
	fileSystemReady: boolean,
): string | null {
	const missing: string[] = [];
	if (!fileSystemReady) missing.push("the file system to finish provisioning");
	if (!item.network.configured) missing.push("the runtime to be in the VPC");
	if (!item.permissions.configured) missing.push("the IAM permissions");
	return missing.length === 0 ? null : `Waiting for ${missing.join(", ")}.`;
}

export function StartAssessmentWizard({
	journey,
	agents,
	runtimes,
	open,
	onOpenChange,
}: {
	journey: Journey;
	agents: JourneyAgent[];
	runtimes: AgentRuntime[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const navigate = useNavigate();

	const [activeStep, setActiveStep] = useState(0);
	const [selected, setSelected] = useState<string[]>([]);
	const [isSyncing, setIsSyncing] = useState(false);
	const [validation, setValidation] = useState<JourneyAgentsValidation | null>(
		null,
	);
	const [isValidating, setIsValidating] = useState(false);
	/** Fixes in flight, keyed "runtimeId:fix", so buttons are independent. */
	const [busy, setBusy] = useState<Set<string>>(new Set());
	const [isLaunching, setIsLaunching] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const showError = (caught: unknown, fallback: string) => {
		setError(
			caught instanceof Error && caught.message ? caught.message : fallback,
		);
	};

	// Reset the wizard only when the dialog transitions from closed to open.
	// The `agents` prop changes mid-flow (router.invalidate() after saving
	// assignments re-runs the loader), and that must not reset the step.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			setActiveStep(0);
			setSelected(agents.map((agent) => agent.agentRuntimeId));
			setValidation(null);
			setBusy(new Set());
			setError(null);
		}
		wasOpen.current = open;
	}, [open, agents]);

	const toggle = (id: string) => {
		setSelected((current) =>
			current.includes(id)
				? current.filter((item) => item !== id)
				: [...current, id],
		);
	};

	const runValidation = useCallback(
		async (options: { silent?: boolean } = {}) => {
			if (!options.silent) {
				setIsValidating(true);
				setError(null);
			}
			try {
				setValidation(
					await client.journeys.agents.validate({ journeyId: journey.id }),
				);
			} catch (caught) {
				if (!options.silent) {
					setError(
						caught instanceof Error && caught.message
							? caught.message
							: "Validation failed. Please try again.",
					);
				}
			} finally {
				if (!options.silent) setIsValidating(false);
			}
		},
		[journey.id],
	);

	// Poll while anything is still settling on the validate step. Silent so
	// the list doesn't flash; results just update in place.
	const settling =
		validation !== null &&
		(!validation.fileSystem.ready ||
			validation.agents.some((item) => item.runtimeStatus === "UPDATING"));
	useEffect(() => {
		if (!open || activeStep !== 1 || !settling) return;
		const interval = setInterval(
			() => void runValidation({ silent: true }),
			POLL_INTERVAL_MS,
		);
		return () => clearInterval(interval);
	}, [open, activeStep, settling, runValidation]);

	// Step 1 -> 2: sync assignments to the selection, then validate.
	const syncAgentsAndContinue = async () => {
		setIsSyncing(true);
		setError(null);
		try {
			const assignedIds = new Set(agents.map((agent) => agent.agentRuntimeId));
			const toAssign = runtimes.filter(
				(runtime) =>
					runtime.agentRuntimeId &&
					selected.includes(runtime.agentRuntimeId) &&
					!assignedIds.has(runtime.agentRuntimeId),
			);
			const toRemove = agents.filter(
				(agent) => !selected.includes(agent.agentRuntimeId),
			);

			if (toAssign.length > 0) {
				await client.journeys.agents.assign({
					journeyId: journey.id,
					agents: toAssign.map((runtime) => ({
						agentRuntimeId: runtime.agentRuntimeId ?? "",
						agentRuntimeArn: runtime.agentRuntimeArn ?? "",
						agentRuntimeName: runtime.agentRuntimeName,
					})),
				});
			}
			for (const agent of toRemove) {
				await client.journeys.agents.unassign({
					journeyId: journey.id,
					agentRuntimeId: agent.agentRuntimeId,
				});
			}
			await router.invalidate();

			setActiveStep(1);
			void runValidation();
		} catch (caught) {
			showError(
				caught,
				"Could not update agent assignments. Please try again.",
			);
		} finally {
			setIsSyncing(false);
		}
	};

	const busyKey = (agentRuntimeId: string, fix: Fix) =>
		`${agentRuntimeId}:${fix}`;
	const isBusy = (agentRuntimeId: string, fix: Fix) =>
		busy.has(busyKey(agentRuntimeId, fix));

	/**
	 * Runs one fix; each call marks only its own button busy. Fixes are applied
	 * one click at a time on purpose: chaining runtime updates (network, then
	 * mounts) raced AgentCore's UPDATING state and failed with
	 * ConflictException. The Mounts button stays disabled until the runtime is
	 * READY and its prerequisites are confirmed by validation.
	 */
	const configureAgent = async (
		agentRuntimeId: string,
		fix: Fix,
	): Promise<void> => {
		const key = busyKey(agentRuntimeId, fix);
		setBusy((current) => new Set(current).add(key));
		setError(null);
		try {
			const result = await FIXES[fix].run({
				journeyId: journey.id,
				agentRuntimeId,
			});
			setValidation((current) =>
				current
					? {
							...current,
							agents: current.agents.map((item) =>
								item.agentRuntimeId === agentRuntimeId ? result : item,
							),
						}
					: current,
			);
		} catch (caught) {
			showError(caught, FIXES[fix].fallback);
			// Re-validate so the rows reflect reality after a failed fix instead
			// of going stale.
			void runValidation({ silent: true });
		} finally {
			setBusy((current) => {
				const next = new Set(current);
				next.delete(key);
				return next;
			});
		}
	};

	const launch = async () => {
		setIsLaunching(true);
		setError(null);
		try {
			const assessment = await client.assessments.start({
				journeyId: journey.id,
			});
			await router.invalidate();
			onOpenChange(false);
			await navigate({
				to: "/journeys/$journeyId/assessments/$assessmentId",
				params: { journeyId: journey.id, assessmentId: assessment.id },
			});
		} catch (caught) {
			showError(caught, "Could not start the assessment. Please try again.");
			setIsLaunching(false);
		}
	};

	const fileSystemReady = validation?.fileSystem.ready ?? false;
	const allConfigured =
		validation !== null &&
		fileSystemReady &&
		validation.agents.length > 0 &&
		validation.agents.every((item) => item.configured);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Start assessment</DialogTitle>
					<DialogDescription>
						Assign agents, validate their file system access, and launch the
						assessment for {journey.name}.
					</DialogDescription>
				</DialogHeader>

				<Stepper
					steps={STEPS}
					activeStep={activeStep}
					onStepClick={(step) => {
						setError(null);
						setActiveStep(step);
					}}
					className="py-2"
				/>

				<Separator />

				{activeStep === 0 && (
					<div className="flex flex-col gap-3">
						<p className="text-muted-foreground text-sm">
							Select the AgentCore runtimes that will assess this migration.
						</p>
						<div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
							{runtimes.length === 0 && (
								<p className="text-muted-foreground py-6 text-center text-sm">
									No agent runtimes found. Create one first.
								</p>
							)}
							{runtimes.map((runtime) => {
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
											<p className="text-muted-foreground truncate text-xs">
												{id}
											</p>
										</div>
									</label>
								);
							})}
						</div>
						<div className="flex justify-end">
							<Button
								onClick={() => void syncAgentsAndContinue()}
								disabled={selected.length === 0 || isSyncing}
							>
								{isSyncing ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
										Saving…
									</>
								) : (
									"Continue"
								)}
							</Button>
						</div>
					</div>
				)}

				{activeStep === 1 && (
					<div className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<p className="text-muted-foreground text-sm">
								Each runtime needs to be in the journey VPC, hold the IAM
								permissions to read the file system, and have it mounted. Apply
								the fixes one at a time; attaching the file system unlocks once
								the other two pass and the file system is ready.
							</p>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => void runValidation()}
								disabled={isValidating}
							>
								<RefreshCw
									className={`h-4 w-4 ${isValidating ? "animate-spin" : ""}`}
									aria-hidden
								/>
								Re-check
							</Button>
						</div>

						{validation && (
							<FileSystemStatusRow
								status={validation.fileSystem}
								polling={settling && !fileSystemReady}
							/>
						)}

						<div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
							{isValidating && validation === null && (
								<p className="text-muted-foreground py-6 text-center text-sm">
									Checking runtime configurations…
								</p>
							)}
							{validation?.agents.map((item) => {
								const blocked = mountsBlockedBy(item, fileSystemReady);
								return (
									<div
										key={item.agentRuntimeId}
										className="flex flex-col gap-2 rounded-lg border p-3"
									>
										<div className="flex items-center gap-2">
											{item.configured ? (
												<CheckCircle2
													className="h-4 w-4 shrink-0 text-green-500"
													aria-hidden
												/>
											) : (
												<XCircle
													className="text-destructive h-4 w-4 shrink-0"
													aria-hidden
												/>
											)}
											<p className="min-w-0 truncate text-sm font-medium">
												{item.agentRuntimeName ?? item.agentRuntimeId}
											</p>
											<span className="ml-auto flex shrink-0 items-center gap-2">
												{item.runtimeStatus && (
													<span className="text-muted-foreground flex items-center gap-1 text-xs">
														{item.runtimeStatus === "UPDATING" && (
															<Loader2
																className="h-3 w-3 animate-spin"
																aria-hidden
															/>
														)}
														{item.runtimeStatus}
													</span>
												)}
											</span>
										</div>
										{item.error ? (
											<p className="text-destructive text-xs">{item.error}</p>
										) : (
											<div className="flex flex-col gap-1.5 pl-6">
												<CheckRow
													ok={item.permissions.configured}
													label="IAM"
													detail={item.permissions.detail}
													action="Grant access"
													busy={isBusy(item.agentRuntimeId, "permissions")}
													onFix={() =>
														void configureAgent(
															item.agentRuntimeId,
															"permissions",
														)
													}
												/>
												<CheckRow
													ok={item.network.configured}
													label="Network"
													detail={item.network.detail}
													action="Move to VPC"
													busy={isBusy(item.agentRuntimeId, "network")}
													disabled={item.runtimeStatus === "UPDATING"}
													onFix={() =>
														void configureAgent(item.agentRuntimeId, "network")
													}
												/>
												<CheckRow
													ok={item.mounts.configured}
													label="Mounts"
													detail={
														item.mounts.configured
															? "File system attached"
															: `Missing: ${item.mounts.missingMounts.join(", ")}`
													}
													action="Attach file system"
													busy={isBusy(item.agentRuntimeId, "mounts")}
													disabled={
														blocked !== null ||
														item.runtimeStatus === "UPDATING"
													}
													disabledReason={blocked ?? undefined}
													onFix={() =>
														void configureAgent(item.agentRuntimeId, "mounts")
													}
												/>
											</div>
										)}
									</div>
								);
							})}
						</div>
						<div className="flex justify-end">
							<Button
								onClick={() => setActiveStep(2)}
								disabled={!allConfigured}
							>
								Continue
							</Button>
						</div>
					</div>
				)}

				{activeStep === 2 && (
					<div className="flex flex-col gap-4">
						<div className="bg-muted/50 rounded-lg border p-4 text-sm">
							<p className="font-medium">Ready to launch</p>
							<ul className="text-muted-foreground mt-2 flex list-disc flex-col gap-1 pl-5">
								<li>
									{selected.length} agent{selected.length === 1 ? "" : "s"}{" "}
									assigned and validated
								</li>
								<li>Source mounted read-only at /mnt/source</li>
								{journey.targetAccessPointArn && (
									<li>Target mounted read-only at /mnt/target</li>
								)}
							</ul>
							<p className="text-muted-foreground mt-3 text-xs">
								Launching runs every assigned agent against the mounted data,
								then the aggregator agent consolidates their reports. This can
								take several minutes.
							</p>
						</div>
						<div className="flex justify-end">
							<Button onClick={() => void launch()} disabled={isLaunching}>
								{isLaunching ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
										Launching…
									</>
								) : (
									<>
										<Rocket className="h-4 w-4" aria-hidden />
										Launch assessment
									</>
								)}
							</Button>
						</div>
					</div>
				)}

				{error && (
					<p className="text-destructive text-sm break-words">{error}</p>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Journey-level: the file system's mount targets. Shared by every agent. */
function FileSystemStatusRow({
	status,
	polling,
}: {
	status: JourneyAgentsValidation["fileSystem"];
	polling: boolean;
}) {
	if (status.total === 0) return null;
	return (
		<div className="bg-muted/50 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
			<HardDrive
				className="text-muted-foreground h-4 w-4 shrink-0"
				aria-hidden
			/>
			{status.error ? (
				<span className="text-destructive">{status.error}</span>
			) : status.ready ? (
				<span className="flex items-center gap-1.5">
					<CheckCircle2 className="h-3.5 w-3.5 text-green-500" aria-hidden />
					File system ready ({status.available}/{status.total} mount targets
					available)
				</span>
			) : (
				<span className="text-muted-foreground flex items-center gap-1.5">
					{polling && (
						<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
					)}
					File system provisioning: {status.available}/{status.total} mount
					targets available. Usually a few minutes; mounts unlock automatically.
				</span>
			)}
		</div>
	);
}

function CheckRow({
	ok,
	label,
	detail,
	action,
	busy,
	disabled = false,
	disabledReason,
	onFix,
}: {
	ok: boolean;
	label: string;
	detail: string;
	action: string;
	busy: boolean;
	disabled?: boolean;
	disabledReason?: string;
	onFix: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-2">
			<p
				className="text-muted-foreground min-w-0 truncate text-xs"
				title={detail}
			>
				{ok ? "✓" : "✗"} {label}: {detail}
			</p>
			{!ok && (
				<Button
					size="sm"
					variant="secondary"
					onClick={onFix}
					disabled={busy || disabled}
					title={!busy && disabled ? disabledReason : undefined}
				>
					{busy ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
							Updating…
						</>
					) : (
						action
					)}
				</Button>
			)}
		</div>
	);
}
