import type Database from "better-sqlite3";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    source: text("source"),
    sourceEventId: text("source_event_id"),
    status: text("status").notNull(),
    eventJson: text("event_json").notNull(),
    resultJson: text("result_json"),
    assignedRunnerId: text("assigned_runner_id"),
    executor: text("executor"),
    leasedAt: text("leased_at"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    statusIdx: index("runs_status_idx").on(table.status),
    runnerIdx: index("runs_runner_idx").on(table.assignedRunnerId),
    sourceEventUniqueIdx: uniqueIndex("runs_source_event_idx").on(table.source, table.sourceEventId)
  })
);

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
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
      source TEXT,
      source_event_id TEXT,
      status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      result_json TEXT,
      assigned_runner_id TEXT,
      executor TEXT,
      leased_at TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
    CREATE INDEX IF NOT EXISTS runs_runner_idx ON runs(assigned_runner_id);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_source_event_idx
      ON runs(source, source_event_id);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
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
  if (!runColumnNames.has("source")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN source TEXT");
  }
  if (!runColumnNames.has("source_event_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN source_event_id TEXT");
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_source_event_idx ON runs(source, source_event_id)");

  const callbackColumns = sqlite.prepare("PRAGMA table_info(callback_deliveries)").all() as { name: string }[];
  const callbackColumnNames = new Set(callbackColumns.map((column) => column.name));
  if (!callbackColumnNames.has("next_attempt_at")) {
    sqlite.exec("ALTER TABLE callback_deliveries ADD COLUMN next_attempt_at TEXT");
  }
}
