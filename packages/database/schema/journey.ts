import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const journey = pgTable(
  "journey",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // All journey data lives in a single bucket; source/target are paths within it.
    bucketName: text("bucket_name").notNull(),
    sourcePath: text("source_path").notNull(),
    targetPath: text("target_path"),
    migrationType: text("migration_type"),
    description: text("description"),
    // S3 Files resources provisioned at creation time.
    fileSystemId: text("file_system_id"),
    fileSystemArn: text("file_system_arn"),
    sourceAccessPointId: text("source_access_point_id"),
    sourceAccessPointArn: text("source_access_point_arn"),
    targetAccessPointId: text("target_access_point_id"),
    targetAccessPointArn: text("target_access_point_arn"),
    mountTargetIds: text("mount_target_ids").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("journey_name_idx").on(table.name)],
);

export const journeyAgent = pgTable(
  "journey_agent",
  {
    id: text("id").primaryKey(),
    journeyId: text("journey_id")
      .notNull()
      .references(() => journey.id, { onDelete: "cascade" }),
    agentRuntimeId: text("agent_runtime_id").notNull(),
    agentRuntimeArn: text("agent_runtime_arn").notNull(),
    agentRuntimeName: text("agent_runtime_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("journey_agent_journeyId_idx").on(table.journeyId),
    uniqueIndex("journey_agent_journeyId_runtimeId_uidx").on(
      table.journeyId,
      table.agentRuntimeId,
    ),
  ],
);

export const assessment = pgTable(
  "assessment",
  {
    id: text("id").primaryKey(),
    journeyId: text("journey_id")
      .notNull()
      .references(() => journey.id, { onDelete: "cascade" }),
    // RUNNING | COMPLETED | FAILED
    status: text("status").notNull(),
    // Agent runtime IDs that participated in this assessment run.
    agentRuntimeIds: text("agent_runtime_ids").array().notNull(),
    // Consolidated Markdown report produced by the aggregator agent.
    report: text("report"),
    // Why the run FAILED, when it did.
    error: text("error"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [index("assessment_journeyId_idx").on(table.journeyId)],
);
