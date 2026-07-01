import type Database from "better-sqlite3";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    status: text("status").notNull(),
    eventJson: text("event_json").notNull(),
    contextPacketJson: text("context_packet_json"),
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
    conversationKey: text("conversation_key"),
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
    workThreadIdx: index("runs_work_thread_idx").on(table.workThreadId),
    conversationIdx: index("runs_conversation_idx").on(table.conversationKey)
  })
);

export const followUpRequests = sqliteTable(
  "follow_up_requests",
  {
    id: text("id").primaryKey(),
    sourceEventId: text("source_event_id").notNull(),
    conversationKey: text("conversation_key").notNull(),
    activeRunId: text("active_run_id"),
    eventJson: text("event_json").notNull(),
    decisionJson: text("decision_json").notNull(),
    status: text("status").notNull(),
    createdRunId: text("created_run_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    sourceEventIdx: uniqueIndex("follow_up_requests_source_event_idx").on(table.sourceEventId),
    conversationIdx: index("follow_up_requests_conversation_idx").on(table.conversationKey, table.status)
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

export const sourceDeliveries = sqliteTable(
  "source_deliveries",
  {
    source: text("source").notNull(),
    deliveryId: text("delivery_id").notNull(),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.deliveryId] }),
    runIdx: index("source_deliveries_run_idx").on(table.runId)
  })
);

export const controlPlaneEvents = sqliteTable(
  "control_plane_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    subject: text("subject"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    typeIdx: index("control_plane_events_type_idx").on(table.type),
    severityIdx: index("control_plane_events_severity_idx").on(table.severity)
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

export const channelBindings = sqliteTable(
  "channel_bindings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    accountId: text("account_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    repoProvider: text("repo_provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    channelBindingUniqueIdx: uniqueIndex("channel_bindings_provider_account_conversation_idx").on(
      table.provider,
      table.accountId,
      table.conversationId
    )
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
    idempotencyKey: text("idempotency_key"),
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
    callbackStatusIdx: index("callback_deliveries_status_idx").on(table.status),
    callbackIdempotencyIdx: uniqueIndex("callback_deliveries_idempotency_key_idx").on(table.idempotencyKey)
  })
);

export function migrateSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      context_packet_json TEXT,
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
      conversation_key TEXT,
      leased_at TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
    CREATE INDEX IF NOT EXISTS runs_runner_idx ON runs(assigned_runner_id);
    CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_key);
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
    CREATE TABLE IF NOT EXISTS source_deliveries (
      source TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source, delivery_id)
    );
    CREATE INDEX IF NOT EXISTS source_deliveries_run_idx
      ON source_deliveries(run_id);
    CREATE TABLE IF NOT EXISTS control_plane_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      subject TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS control_plane_events_type_idx
      ON control_plane_events(type);
    CREATE INDEX IF NOT EXISTS control_plane_events_severity_idx
      ON control_plane_events(severity);
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
    CREATE TABLE IF NOT EXISTS channel_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      repo_provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_provider_account_conversation_idx
      ON channel_bindings(provider, account_id, conversation_id);
    CREATE TABLE IF NOT EXISTS callback_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      uri TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_key TEXT,
      idempotency_key TEXT,
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
    CREATE UNIQUE INDEX IF NOT EXISTS callback_deliveries_idempotency_key_idx
      ON callback_deliveries(idempotency_key);
    CREATE TABLE IF NOT EXISTS follow_up_requests (
      id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      active_run_id TEXT,
      event_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS follow_up_requests_source_event_idx
      ON follow_up_requests(source_event_id);
    CREATE INDEX IF NOT EXISTS follow_up_requests_conversation_idx
      ON follow_up_requests(conversation_key, status);
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
  const channelBindingColumns = sqlite.prepare("PRAGMA table_info(channel_bindings)").all() as { name: string }[];
  const channelBindingColumnNames = new Set(channelBindingColumns.map((column) => column.name));
  if (!channelBindingColumnNames.has("repo_provider")) {
    sqlite.exec("ALTER TABLE channel_bindings ADD COLUMN repo_provider TEXT");
    sqlite.exec("UPDATE channel_bindings SET repo_provider = 'github' WHERE repo_provider IS NULL");
  }
  if (!channelBindingColumnNames.has("metadata_json")) {
    sqlite.exec("ALTER TABLE channel_bindings ADD COLUMN metadata_json TEXT");
  }
  const runColumns = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  const runColumnNames = new Set(runColumns.map((column) => column.name));
  if (!runColumnNames.has("leased_at")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN leased_at TEXT");
  }
  if (!runColumnNames.has("context_packet_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN context_packet_json TEXT");
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
  if (!runColumnNames.has("conversation_key")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN conversation_key TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_repo_idx ON runs(repo_provider, repo_owner, repo_name)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_work_thread_idx ON runs(work_thread_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_key)");
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
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS source_deliveries (
      source TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source, delivery_id)
    );
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS source_deliveries_run_idx ON source_deliveries(run_id)");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS control_plane_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      subject TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS control_plane_events_type_idx ON control_plane_events(type)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS control_plane_events_severity_idx ON control_plane_events(severity)");
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
  if (!callbackColumnNames.has("idempotency_key")) {
    sqlite.exec("ALTER TABLE callback_deliveries ADD COLUMN idempotency_key TEXT");
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS callback_deliveries_idempotency_key_idx ON callback_deliveries(idempotency_key)");
  const legacySlackTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slack_channel_bindings'")
    .get() as { name: string } | undefined;
  if (legacySlackTable) {
    sqlite.exec(`
      INSERT OR IGNORE INTO channel_bindings (
        provider,
        account_id,
        conversation_id,
        repo_provider,
        owner,
        repo,
        created_at
      )
      SELECT
        'slack',
        team_id,
        channel_id,
        'github',
        owner,
        repo,
        created_at
      FROM slack_channel_bindings;
    `);
  }
}
