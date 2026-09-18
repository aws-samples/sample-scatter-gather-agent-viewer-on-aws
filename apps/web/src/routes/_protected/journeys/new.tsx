import type { BucketReadiness } from "@repo/api/router";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import * as z from "zod";
import { BucketCombobox } from "@/components/bucket-combobox";
import { PathCombobox } from "@/components/path-combobox";
import { Button } from "@/components/ui/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSeparator,
	FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { JOURNEYS_CRUMB } from "@/lib/breadcrumbs";
import { client } from "@/orpc/client";

export const Route = createFileRoute("/_protected/journeys/new")({
	staticData: { crumb: [JOURNEYS_CRUMB, "New journey"] },
	component: NewJourneyPage,
});

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const notAFullUri = (value: string) => !value.startsWith("s3://");

const journeyFormSchema = z.object({
	name: z.string().trim().min(1, "Name is required").max(120),
	bucketName: z
		.string()
		.trim()
		.regex(BUCKET_NAME_PATTERN, "Must be a valid S3 bucket name"),
	sourcePath: z
		.string()
		.trim()
		.min(1, "Source path is required")
		.max(1024)
		.refine(
			notAFullUri,
			"Provide the path within the bucket, not a full S3 URI",
		),
	targetPath: z
		.string()
		.trim()
		.max(1024)
		.refine(
			notAFullUri,
			"Provide the path within the bucket, not a full S3 URI",
		),
	migrationType: z.string().trim().max(120),
	description: z.string().trim().max(2000),
});

function ReadinessRow({ ok, label }: { ok: boolean; label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm">
			{ok ? (
				<CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden />
			) : (
				<XCircle className="text-destructive h-4 w-4" aria-hidden />
			)}
			<span>{label}</span>
		</div>
	);
}

function NewJourneyPage() {
	const router = useRouter();
	const navigate = Route.useNavigate();
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [bucketCheck, setBucketCheck] = useState<{
		bucket: string;
		readiness: BucketReadiness;
	} | null>(null);
	const [isCheckingBucket, setIsCheckingBucket] = useState(false);
	const [isPreparingBucket, setIsPreparingBucket] = useState(false);
	const [bucketActionError, setBucketActionError] = useState<string | null>(
		null,
	);

	const checkBucket = async (bucketName: string) => {
		setBucketActionError(null);
		setIsCheckingBucket(true);
		try {
			const readiness = await client.journeys.checkBucket({ bucketName });
			setBucketCheck({ bucket: bucketName, readiness });
			return readiness;
		} catch {
			setBucketActionError("Could not check the bucket. Please try again.");
			return null;
		} finally {
			setIsCheckingBucket(false);
		}
	};

	const fixBucket = async (bucketName: string) => {
		setBucketActionError(null);
		setIsPreparingBucket(true);
		try {
			const readiness = await client.journeys.prepareBucket({ bucketName });
			setBucketCheck({ bucket: bucketName, readiness });
		} catch {
			setBucketActionError(
				"Could not update the bucket settings. Please try again.",
			);
		} finally {
			setIsPreparingBucket(false);
		}
	};

	const form = useForm({
		defaultValues: {
			name: "",
			bucketName: "",
			sourcePath: "",
			targetPath: "",
			migrationType: "",
			description: "",
		},
		validators: {
			onSubmit: journeyFormSchema,
		},
		onSubmit: async ({ value }) => {
			setSubmitError(null);

			const bucketName = value.bucketName.trim();
			const readiness =
				bucketCheck?.bucket === bucketName
					? bucketCheck.readiness
					: await checkBucket(bucketName);

			if (!readiness) {
				return;
			}
			if (!readiness.ready) {
				setSubmitError(
					readiness.error ??
						"The bucket doesn't meet the requirements yet. Fix the settings below and try again.",
				);
				return;
			}

			// Paths are checked on blur, but the user may submit without ever
			// leaving the field; a journey against an empty folder is useless.
			const pathsToVerify = [
				{ label: "Source path", path: value.sourcePath.trim() },
				...(value.targetPath.trim()
					? [{ label: "Target path", path: value.targetPath.trim() }]
					: []),
			];
			for (const { label, path } of pathsToVerify) {
				const result = await client.journeys
					.checkPath({ bucketName, path })
					.catch(() => null);
				if (!result?.exists) {
					setSubmitError(
						result?.error ??
							`${label}: no objects found under s3://${bucketName}/${path.replace(/^\/+|\/+$/g, "")}/`,
					);
					return;
				}
			}

			try {
				const journey = await client.journeys.create({
					name: value.name.trim(),
					bucketName: value.bucketName.trim(),
					sourcePath: value.sourcePath.trim(),
					targetPath: value.targetPath.trim() || undefined,
					migrationType: value.migrationType.trim() || undefined,
					description: value.description.trim() || undefined,
				});

				await router.invalidate();
				await navigate({
					to: "/journeys/$journeyId",
					params: { journeyId: journey.id },
				});
			} catch {
				setSubmitError("Failed to create journey. Please try again.");
			}
		},
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="mx-auto w-full max-w-2xl px-2 py-2 md:py-3 lg:px-3">
				<div className="mb-4 flex items-center gap-3">
					<Button
						variant="ghost"
						size="icon"
						nativeButton={false}
						render={<Link to="/journeys" aria-label="Back to journeys" />}
					>
						<ArrowLeft className="h-4 w-4" />
					</Button>
					<div>
						<h1 className="text-2xl font-semibold">Create journey</h1>
						<p className="text-muted-foreground text-sm">
							Describe the migration so the agents can assess it.
						</p>
					</div>
				</div>

				<form
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
					className="bg-card rounded-xl border p-6 shadow-sm"
				>
					<FieldGroup>
						<form.Field name="name">
							{(field) => (
								<Field data-invalid={!field.state.meta.isValid}>
									<FieldLabel htmlFor={field.name}>Name</FieldLabel>
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(event) => field.handleChange(event.target.value)}
										placeholder="Project Alpha"
										maxLength={120}
										aria-invalid={!field.state.meta.isValid}
										autoFocus
									/>
									<FieldDescription>
										A short, descriptive name for this journey.
									</FieldDescription>
									<FieldError errors={field.state.meta.errors} />
								</Field>
							)}
						</form.Field>

						<FieldSeparator />

						<FieldSet>
							<FieldLegend>Environments</FieldLegend>
							<FieldDescription>
								Source and target live in the same S3 bucket. A read-only file
								system access point is created for each path so the agents can
								assess the migration.
							</FieldDescription>
							<FieldGroup>
								<form.Field name="bucketName">
									{(field) => {
										const trimmed = field.state.value.trim();
										const status =
											bucketCheck?.bucket === trimmed && trimmed !== ""
												? bucketCheck.readiness
												: null;

										return (
											<Field data-invalid={!field.state.meta.isValid}>
												<FieldLabel htmlFor={field.name}>Bucket</FieldLabel>
												<BucketCombobox
													id={field.name}
													name={field.name}
													value={field.state.value}
													onChange={field.handleChange}
													onBlur={field.handleBlur}
													onCommit={(bucketName) =>
														void checkBucket(bucketName)
													}
													invalid={!field.state.meta.isValid}
												/>
												<FieldDescription>
													Pick a bucket in this region or type its name. It
													needs versioning and default encryption enabled for S3
													Files; we check that when you leave the field.
												</FieldDescription>
												{isCheckingBucket && (
													<p className="text-muted-foreground flex items-center gap-2 text-sm">
														<Loader2
															className="h-4 w-4 animate-spin"
															aria-hidden
														/>
														Checking bucket settings…
													</p>
												)}
												{status &&
													!isCheckingBucket &&
													(status.accessible ? (
														<div className="bg-muted/50 flex flex-col gap-2 rounded-lg border p-3">
															<ReadinessRow
																ok={status.versioningEnabled}
																label="Versioning enabled"
															/>
															<ReadinessRow
																ok={status.encryptionCompliant}
																label="Default encryption (SSE-S3 or SSE-KMS)"
															/>
															{!status.ready && (
																<Button
																	type="button"
																	variant="secondary"
																	size="sm"
																	className="mt-1 w-fit"
																	disabled={isPreparingBucket}
																	onClick={() => void fixBucket(trimmed)}
																>
																	{isPreparingBucket ? (
																		<>
																			<Loader2
																				className="h-4 w-4 animate-spin"
																				aria-hidden
																			/>
																			Updating bucket…
																		</>
																	) : (
																		"Enable required settings"
																	)}
																</Button>
															)}
														</div>
													) : (
														<FieldError>
															{status.error ?? "Could not inspect the bucket."}
														</FieldError>
													))}
												{bucketActionError && (
													<FieldError>{bucketActionError}</FieldError>
												)}
												<FieldError errors={field.state.meta.errors} />
											</Field>
										);
									}}
								</form.Field>

								{/* Paths only make sense once we know which bucket to browse. */}
								<form.Subscribe selector={(state) => state.values.bucketName}>
									{(bucketName) => {
										const readyBucket =
											bucketCheck?.bucket === bucketName.trim() &&
											bucketCheck.readiness.accessible
												? bucketCheck.bucket
												: null;

										if (!readyBucket) {
											return (
												<p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
													Choose a bucket to pick the source and target paths.
												</p>
											);
										}

										return (
											<>
												<form.Field name="sourcePath">
													{(field) => (
														<Field data-invalid={!field.state.meta.isValid}>
															<FieldLabel htmlFor={field.name}>
																Source path
															</FieldLabel>
															<PathCombobox
																id={field.name}
																name={field.name}
																bucketName={readyBucket}
																value={field.state.value}
																onChange={field.handleChange}
																onBlur={field.handleBlur}
																invalid={!field.state.meta.isValid}
																placeholder="source/app-code"
															/>
															<FieldDescription>
																Folder within the bucket holding the source
																environment. Start typing to browse.
															</FieldDescription>
															<FieldError errors={field.state.meta.errors} />
														</Field>
													)}
												</form.Field>

												<form.Field name="targetPath">
													{(field) => (
														<Field data-invalid={!field.state.meta.isValid}>
															<FieldLabel htmlFor={field.name}>
																Target path{" "}
																<span className="text-muted-foreground font-normal">
																	(optional)
																</span>
															</FieldLabel>
															<PathCombobox
																id={field.name}
																name={field.name}
																bucketName={readyBucket}
																value={field.state.value}
																onChange={field.handleChange}
																onBlur={field.handleBlur}
																invalid={!field.state.meta.isValid}
																placeholder="target/app-code"
																allowEmpty
															/>
															<FieldDescription>
																Folder within the same bucket holding the target
																environment. Leave empty if this migration has
																no target.
															</FieldDescription>
															<FieldError errors={field.state.meta.errors} />
														</Field>
													)}
												</form.Field>
											</>
										);
									}}
								</form.Subscribe>
							</FieldGroup>
						</FieldSet>

						<FieldSeparator />

						<FieldSet>
							<FieldLegend>
								Additional details{" "}
								<span className="text-muted-foreground text-sm font-normal">
									(optional)
								</span>
							</FieldLegend>
							<FieldGroup>
								<form.Field name="migrationType">
									{(field) => (
										<Field data-invalid={!field.state.meta.isValid}>
											<FieldLabel htmlFor={field.name}>
												Migration type
											</FieldLabel>
											<Input
												id={field.name}
												name={field.name}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(event) =>
													field.handleChange(event.target.value)
												}
												placeholder="e.g. rehost, replatform, refactor"
												maxLength={120}
												aria-invalid={!field.state.meta.isValid}
											/>
											<FieldError errors={field.state.meta.errors} />
										</Field>
									)}
								</form.Field>

								<form.Field name="description">
									{(field) => (
										<Field data-invalid={!field.state.meta.isValid}>
											<FieldLabel htmlFor={field.name}>Description</FieldLabel>
											<Textarea
												id={field.name}
												name={field.name}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(event) =>
													field.handleChange(event.target.value)
												}
												placeholder="Anything else the agents should know when assessing this migration."
												maxLength={2000}
												rows={4}
												aria-invalid={!field.state.meta.isValid}
											/>
											<FieldError errors={field.state.meta.errors} />
										</Field>
									)}
								</form.Field>
							</FieldGroup>
						</FieldSet>

						{submitError && <FieldError>{submitError}</FieldError>}

						<div className="flex justify-end gap-2">
							<Button
								variant="outline"
								nativeButton={false}
								render={<Link to="/journeys" />}
							>
								Cancel
							</Button>
							<form.Subscribe selector={(state) => state.isSubmitting}>
								{(isSubmitting) => (
									<Button type="submit" disabled={isSubmitting}>
										{isSubmitting ? "Creating…" : "Create journey"}
									</Button>
								)}
							</form.Subscribe>
						</div>
					</FieldGroup>
				</form>
			</div>
		</div>
	);
}
