import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
export const meetings = sqliteTable(
  "meetings",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    fingerprint: text("fingerprint").notNull(),
    data: text("data").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [uniqueIndex("meeting_content").on(t.owner, t.fingerprint)],
);
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    meetingId: text("meeting_id").notNull(),
    itemId: text("item_id").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull(),
    url: text("url").notNull().default(""),
    error: text("error").notNull().default(""),
    createdAt: text("created_at").notNull(),
    issueTarget: text("issue_target"),
    attemptedAt: integer("attempted_at"),
    followupOf: text("followup_of"),
    followupDate: text("followup_date"),
    linearKey: text("linear_key"),
  },
  (t) => [
    index("delivery_followup").on(t.owner, t.followupOf),
    uniqueIndex("delivery_linear_key").on(t.owner, t.issueTarget, t.linearKey),
    uniqueIndex("delivery_once").on(
      t.owner,
      t.meetingId,
      t.itemId,
      t.destination,
    ),
  ],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  expires: integer("expires").notNull(),
  actor: text("actor"),
});
export const loginLimits = sqliteTable("login_limits", {
  id: text("id").primaryKey(),
  attempts: integer("attempts").notNull(),
  resetAt: integer("reset_at").notNull(),
});
export const preferences = sqliteTable("preferences", {
  owner: text("owner").primaryKey(),
  data: text("data").notNull(),
  revision: integer("revision").notNull().default(0),
});
export const integrationSettings = sqliteTable(
  "integration_settings",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    destination: text("destination").notNull(),
    data: text("data").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("integration_owner").on(t.owner, t.destination)],
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    workspace: text("workspace").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
  },
  (t) => [uniqueIndex("member_login").on(t.workspace, t.username)],
);
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  workspace: text("workspace").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const meetstreamBots = sqliteTable(
  "meetstream_bots",
  {
    id: text("id").primaryKey().notNull(),
    workspace: text("workspace").notNull(),
    requestId: text("request_id"),
    label: text("label").notNull(),
    createdAt: integer("created_at").notNull(),
    stopRequestedAt: integer("stop_requested_at"),
    meetingId: text("meeting_id").references(() => meetings.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("meetstream_bot_request").on(t.workspace, t.requestId)],
);
