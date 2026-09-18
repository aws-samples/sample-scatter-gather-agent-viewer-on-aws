// Adapted from the Shadcn Space "stepper-03" component
// (https://shadcnspace.com, Copyright (c) 2026 Shadcn Space, MIT License;
// see THIRD-PARTY-LICENSES at the repository root) into a controlled,
// reusable component: steps/active state come in as props, content and
// navigation are owned by the caller. The unmodified original lives at
// src/components/shadcn-space/stepper/stepper-03.tsx.
import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export interface StepperStep {
	title: string;
	icon: LucideIcon;
}

export function Stepper({
	steps,
	activeStep,
	onStepClick,
	className,
}: {
	steps: StepperStep[];
	/** 0-indexed current step. */
	activeStep: number;
	/** Called when a previously visited step is clicked. Omit to disable. */
	onStepClick?: (step: number) => void;
	className?: string;
}) {
	const prefersReducedMotion = useReducedMotion();
	const progress = activeStep / (steps.length - 1);
	const inset = 100 / (steps.length * 2);

	return (
		<div className={cn("relative", className)}>
			<div
				className="bg-border absolute top-5 h-0.5"
				style={{ left: `${inset}%`, right: `${inset}%` }}
			/>
			<motion.div
				className="bg-primary absolute top-5 h-0.5 origin-left"
				style={{ left: `${inset}%`, right: `${inset}%` }}
				initial={false}
				animate={{ scaleX: progress }}
				transition={{ type: "spring", stiffness: 120, damping: 20 }}
			/>
			<motion.span
				className="bg-primary absolute size-2 rounded-full"
				style={{ top: 21, x: "-50%", y: "-50%" }}
				initial={{ left: `${inset}%` }}
				animate={{ left: `${inset + progress * (100 - inset * 2)}%` }}
				transition={{ type: "spring", stiffness: 160, damping: 24 }}
			/>
			<div className="relative flex items-start justify-between">
				{steps.map((step, index) => {
					const isActive = index === activeStep;
					const isCompleted = index < activeStep;
					const clickable = onStepClick !== undefined && index < activeStep;
					return (
						<div
							key={step.title}
							className="flex flex-1 flex-col items-center gap-2"
						>
							<button
								type="button"
								onClick={clickable ? () => onStepClick(index) : undefined}
								disabled={!clickable && !isActive}
								aria-current={isActive ? "step" : undefined}
								aria-label={`${step.title} step`}
								className={cn(
									"group focus-visible:ring-ring focus-visible:ring-offset-background relative z-10 flex size-10 items-center justify-center rounded-full transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
									clickable && "cursor-pointer",
								)}
							>
								<span
									className={cn(
										"absolute inset-0 rounded-full transition-colors duration-300",
										isCompleted || isActive ? "bg-primary" : "bg-muted",
									)}
								/>
								{isActive && !prefersReducedMotion && (
									<motion.span
										className="ring-primary/50 absolute inset-0 rounded-full ring-2"
										initial={{ scale: 1, opacity: 1 }}
										animate={{ scale: [1, 1.45, 1], opacity: [1, 0.2, 1] }}
										transition={{
											duration: 2.2,
											repeat: Infinity,
											repeatType: "mirror",
											ease: "easeInOut",
										}}
									/>
								)}
								<motion.div
									className="relative flex items-center justify-center"
									animate={{ scale: isActive ? 1.1 : 1 }}
									transition={{ type: "spring", stiffness: 320, damping: 18 }}
								>
									<AnimatePresence mode="wait" initial={false}>
										{isCompleted ? (
											<motion.span
												key="check"
												initial={{ scale: 0, rotate: -90, opacity: 0 }}
												animate={{ scale: 1, rotate: 0, opacity: 1 }}
												exit={{ scale: 0, rotate: 90, opacity: 0 }}
												transition={{
													type: "spring",
													stiffness: 400,
													damping: 22,
												}}
												className="text-primary-foreground flex items-center justify-center"
											>
												<Check className="size-5" strokeWidth={3} />
											</motion.span>
										) : (
											<motion.span
												key="icon"
												initial={{ scale: 0, opacity: 0 }}
												animate={{ scale: 1, opacity: 1 }}
												exit={{ scale: 0, opacity: 0 }}
												transition={{
													type: "spring",
													stiffness: 400,
													damping: 22,
												}}
												className="flex items-center justify-center"
											>
												<step.icon
													className={cn(
														"size-5",
														isActive
															? "text-primary-foreground"
															: "text-muted-foreground",
													)}
												/>
											</motion.span>
										)}
									</AnimatePresence>
								</motion.div>
							</button>
							<span
								className={cn(
									"text-xs font-medium transition-colors duration-300",
									isActive || isCompleted
										? "text-foreground"
										: "text-muted-foreground",
								)}
							>
								{step.title}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
