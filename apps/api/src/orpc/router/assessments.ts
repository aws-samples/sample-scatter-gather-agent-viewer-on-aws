import { randomUUID } from "node:crypto";
import { assessment, db, journey, journeyAgent } from "@repo/database";
import { asc, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { assessmentEnvironment, runAssessment } from "../../lib/run-assessment";
import { base as os } from "../base";

export type Assessment = typeof assessment.$inferSelect;

export const listAssessments = os
	.input(z.object({ journeyId: z.string() }))
	.handler(async ({ input }): Promise<Assessment[]> => {
		return db
			.select()
			.from(assessment)
			.where(eq(assessment.journeyId, input.journeyId))
			.orderBy(desc(assessment.startedAt));
	});

export const getAssessment = os
	.input(z.object({ id: z.string() }))
	.handler(async ({ input }): Promise<Assessment | null> => {
		const [result] = await db.select().from(assessment).where(eq(assessment.id, input.id)).limit(1);

		return result ?? null;
	});

/**
 * Records a RUNNING assessment and kicks off the scatter-gather run in the
 * background (see lib/run-assessment.ts): every assigned agent is invoked and
 * its scan report staged in the shared aggregator bucket folder, then the
 * aggregator agent consolidates the folder into the final report. The row
 * flips to COMPLETED or FAILED when the run ends; clients poll `get` to
 * follow along.
 */
export const startAssessment = os
	.input(z.object({ journeyId: z.string() }))
	.handler(async ({ input }): Promise<Assessment> => {
		const [journeyRecord] = await db.select().from(journey).where(eq(journey.id, input.journeyId)).limit(1);
		if (!journeyRecord) {
			throw new Error(`Journey ${input.journeyId} not found`);
		}

		const agents = await db
			.select()
			.from(journeyAgent)
			.where(eq(journeyAgent.journeyId, input.journeyId))
			.orderBy(asc(journeyAgent.createdAt));

		if (agents.length === 0) {
			throw new Error("Assign at least one agent before starting an assessment");
		}

		// Fail the RPC on missing configuration instead of the background run.
		const environment = assessmentEnvironment();

		const [created] = await db
			.insert(assessment)
			.values({
				id: randomUUID(),
				journeyId: input.journeyId,
				status: "RUNNING",
				agentRuntimeIds: agents.map((agent) => agent.agentRuntimeId),
			})
			.returning();

		if (!created) {
			throw new Error("Failed to record assessment");
		}

		// Fire and forget: agent runs take minutes, far beyond an RPC timeout.
		// runAssessment never throws — it records failures on the row itself.
		void runAssessment(created.id, journeyRecord, agents, environment);

		return created;
	});
