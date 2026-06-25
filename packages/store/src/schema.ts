import type Database from "better-sqlite3";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    status: text("status").notNull(),
    eventJson: text("event_json").notNull(),
    resultJson: text("result_json"),
    assignedRunnerId: text("assigned_runner_id"),
    executor: text("executor"),
    parentRunId: text("parent_run_id"),
    triggeredByActionJson: text("triggered_by_action_json"),
    sourceProposalId: text("source_proposal_id"),
    sourceApplyPlanId: text("source_apply_plan_id"),
    repoProvider: text("repo_provider"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    workThreadId: text("work_thread_id"),
    leasedAt: text("leased_at"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    statusIdx: index("runs_status_idx").on(table.status),
    runnerIdx: index("runs_runner_idx").on(table.assignedRunnerId),
    repoIdx: index("runs_repo_idx").on(table.repoProvider, table.repoOwner, table.repoName),
    workThreadIdx: index("runs_work_thread_idx").on(table.workThreadId)
  })
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    visibility: text("visibility").notNull().default("audit"),
    importance: text("importance").notNull().default("normal"),
    message: text("message"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    runIdx: index("run_events_run_idx").on(table.runId)
  })
);

export const suggestedChanges = sqliteTable("suggested_changes", {
  proposalId: text("proposal_id").primaryKey(),
  runId: text("run_id").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const approvalDecisions = sqliteTable("approval_decisions", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  decisionJson: text("decision_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const applyPlans = sqliteTable("apply_plans", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  approvalDecisionId: text("approval_decision_id").notNull(),
  planJson: text("plan_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const runners = sqliteTable("runners", {
  runnerId: text("runner_id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  heartbeatAt: text("heartbeat_at")
});

export const repoBindings = sqliteTable(
  "repo_bindings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    runnerId: text("runner_id").notNull(),
    workspacePath: text("workspace_path"),
    defaultExecutor: text("default_executor"),
    allowedActorsJson: text("allowed_actors_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    repoUniqueIdx: uniqueIndex("repo_bindings_provider_owner_repo_idx").on(table.provider, table.owner, table.repo)
  })
);

export const repoPolicyRules = sqliteTable(
  "repo_policy_rules",
  {
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    ruleJson: text("rule_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.owner, table.repo, table.id] })
  })
);

export const repoMutationMappings = sqliteTable(
  "repo_mutation_mappings",
  {
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    mappingJson: text("mapping_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.owner, table.repo, table.id] })
  })
);

export const slackChannelBindings = sqliteTable(
  "slack_channel_bindings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    slackChannelUniqueIdx: uniqueIndex("slack_channel_bindings_team_channel_idx").on(table.teamId, table.channelId)
  })
);

export const callbackDeliveries = sqliteTable(
  "callback_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    uri: text("uri").notNull(),
    body: text("body").notNull(),
    threadKey: text("thread_key"),
    metadataJson: text("metadata_json"),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: text("next_attempt_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    callbackRunIdx: index("callback_deliveries_run_idx").on(table.runId),
    callbackStatusIdx: index("callback_deliveries_status_idx").on(table.status)
  })
);

export function migrateSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      result_json TEXT,
      assigned_runner_id TEXT,
      executor TEXT,
      parent_run_id TEXT,
      triggered_by_action_json TEXT,
      source_proposal_id TEXT,
      source_apply_plan_id TEXT,
      repo_provider TEXT,
      repo_owner TEXT,
      repo_name TEXT,
      work_thread_id TEXT,
      leased_at TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
    CREATE INDEX IF NOT EXISTS runs_runner_idx ON runs(assigned_runner_id);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'audit',
      importance TEXT NOT NULL DEFAULT 'normal',
      message TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id);
    CREATE TABLE IF NOT EXISTS suggested_changes (
      proposal_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approval_decisions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apply_plans (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      approval_decision_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runners (
      runner_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      heartbeat_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repo_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      workspace_path TEXT,
      default_executor TEXT,
      allowed_actors_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repo_bindings_provider_owner_repo_idx
      ON repo_bindings(provider, owner, repo);
    CREATE TABLE IF NOT EXISTS repo_policy_rules (
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repo_policy_rules_repo_id_idx
      ON repo_policy_rules(provider, owner, repo, id);
    CREATE TABLE IF NOT EXISTS repo_mutation_mappings (
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repo_mutation_mappings_repo_id_idx
      ON repo_mutation_mappings(provider, owner, repo, id);
    CREATE TABLE IF NOT EXISTS slack_channel_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS slack_channel_bindings_team_channel_idx
      ON slack_channel_bindings(team_id, channel_id);
    CREATE TABLE IF NOT EXISTS callback_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      uri TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_key TEXT,
      metadata_json TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS callback_deliveries_run_idx
      ON callback_deliveries(run_id);
    CREATE INDEX IF NOT EXISTS callback_deliveries_status_idx
      ON callback_deliveries(status);
  `);
  const columns = sqlite.prepare("PRAGMA table_info(repo_bindings)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("workspace_path")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN workspace_path TEXT");
  }
  if (!columnNames.has("default_executor")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN default_executor TEXT");
  }
  if (!columnNames.has("allowed_actors_json")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN allowed_actors_json TEXT");
  }
  const runColumns = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  const runColumnNames = new Set(runColumns.map((column) => column.name));
  if (!runColumnNames.has("leased_at")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN leased_at TEXT");
  }
  if (!runColumnNames.has("heartbeat_at")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN heartbeat_at TEXT");
  }
  if (!runColumnNames.has("parent_run_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT");
  }
  if (!runColumnNames.has("triggered_by_action_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN triggered_by_action_json TEXT");
  }
  if (!runColumnNames.has("source_proposal_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN source_proposal_id TEXT");
  }
  if (!runColumnNames.has("source_apply_plan_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN source_apply_plan_id TEXT");
  }
  if (!runColumnNames.has("repo_provider")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN repo_provider TEXT");
  }
  if (!runColumnNames.has("repo_owner")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN repo_owner TEXT");
  }
  if (!runColumnNames.has("repo_name")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN repo_name TEXT");
  }
  if (!runColumnNames.has("work_thread_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN work_thread_id TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_repo_idx ON runs(repo_provider, repo_owner, repo_name)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_work_thread_idx ON runs(work_thread_id)");
  sqlite.exec(`
    UPDATE runs
    SET event_id = event_id || '#duplicate:' || id
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM runs
      GROUP BY event_id
    )
    AND event_id IN (
      SELECT event_id
      FROM runs
      GROUP BY event_id
      HAVING COUNT(*) > 1
    );
  `);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_source_event_id_idx ON runs(event_id)");
  const runEventColumns = sqlite.prepare("PRAGMA table_info(run_events)").all() as { name: string }[];
  const runEventColumnNames = new Set(runEventColumns.map((column) => column.name));
  if (!runEventColumnNames.has("visibility")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'audit'");
  }
  if (!runEventColumnNames.has("importance")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN importance TEXT NOT NULL DEFAULT 'normal'");
  }
  if (!runEventColumnNames.has("message")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN message TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id)");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_policy_rules_repo_id_idx ON repo_policy_rules(provider, owner, repo, id)");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_mutation_mappings_repo_id_idx ON repo_mutation_mappings(provider, owner, repo, id)");
  const callbackColumns = sqlite.prepare("PRAGMA table_info(callback_deliveries)").all() as { name: string }[];
  const callbackColumnNames = new Set(callbackColumns.map((column) => column.name));
  if (!callbackColumnNames.has("next_attempt_at")) {
    sqlite.exec("ALTER TABLE callback_deliveries ADD COLUMN next_attempt_at TEXT");
  }
  if (!callbackColumnNames.has("metadata_json")) {
    sqlite.exec("ALTER TABLE callback_deliveries ADD COLUMN metadata_json TEXT");
  }
}
