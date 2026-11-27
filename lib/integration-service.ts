import { jiraConnection, trelloConnection } from "./work-trackers";
import {
  providerRead,
  linearOptions,
  githubOptions,
} from "./integration-provider";
import { z } from "zod";
import { ACTIVE_ADMIN, audit, db, secret, HttpError, type SessionAccess } from "./server";
import {
  integrationCatalog,
  type IntegrationId,
  type IntegrationConfig,
  type IntegrationStates,
  type IntegrationOptions,
} from "./integration-catalog";
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
async function encryptionKey() {
  const master = secret("APP_SESSION_SECRET");
  if (master.length < 32)
    throw new HttpError(
      503,
      "The application session secret is not configured.",
    );
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(master)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(value: unknown, owner: string, id: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`${owner}:${id}`),
    },
    await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
async function open(value: string, owner: string, id: string) {
  try {
    const [iv, data] = value.split(".");
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: decode(iv),
            additionalData: new TextEncoder().encode(`${owner}:${id}`),
          },
          await encryptionKey(),
          decode(data),
        ),
      ),
    );
  } catch {
    throw new HttpError(
      503,
      "Saved integration settings could not be opened. Restore APP_SESSION_SECRET from your local environment backup.",
    );
  }
}
const inputSchema = z.object({
  site: z.string().trim().max(200).optional(),
  email: z.email().max(254).optional().or(z.literal("")),
  projectKey: z.string().trim().max(31).optional(),
  issueType: z.string().trim().max(100).optional(),
  apiKey: z.string().trim().max(200).optional(),
  listId: z.string().trim().max(24).optional(),
  token: z.string().trim().max(2000).optional(),
  teamId: z.string().trim().max(100).optional(),
  repository: z.string().trim().max(200).optional(),
  assignees: z
    .record(z.string().max(120), z.string().min(1).max(100))
    .refine((x) => Object.keys(x).length <= 200)
    .optional(),
  webhookUrl: z.string().trim().max(2000).optional(),
  parentPageId: z.string().trim().max(500).optional(),
  model: z.string().trim().max(100).optional(),
});
function envConfig(id: IntegrationId): IntegrationConfig {
  let assignees: Record<string, string> = {};
  try {
    const parsed = JSON.parse(
      secret(id === "linear" ? "LINEAR_ASSIGNEES" : "GITHUB_ASSIGNEES") || "{}",
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      assignees = parsed;
  } catch {}
  switch (id) {
    case "webhook":
    case "jira":
    case "trello":
      return {};
    case "linear":
      return {
        token: secret("LINEAR_API_KEY"),
        teamId: secret("LINEAR_TEAM_ID"),
        assignees,
      };
    case "github":
      return {
        token: secret("GITHUB_TOKEN"),
        repository: secret("GITHUB_REPOSITORY"),
        assignees,
      };
    case "slack":
      return { webhookUrl: secret("SLACK_WEBHOOK_URL") };
    case "notion":
      return {
        token: secret("NOTION_API_KEY"),
        parentPageId: secret("NOTION_PARENT_PAGE_ID"),
      };
    case "meetstream":
      return { token: secret("MEETSTREAM_API_KEY") };
    case "ai":
      return {
        token: secret("ANTHROPIC_API_KEY"),
        model: secret("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
      };
  }
}
function configured(id: IntegrationId, c: IntegrationConfig) {
  if (c.disabled) return false;
  if (id === "slack") return !!c.webhookUrl;
  if (id === "webhook")
    return !!c.webhookUrl && !!c.token && c.token.length >= 32;
  if (id === "linear") return !!(c.token && c.teamId);
  if (id === "github") return !!(c.token && c.repository);
  if (id === "jira") return !!(c.token && c.site && c.email && c.projectKey);
  if (id === "trello") return !!(c.token && c.apiKey && c.listId);
  if (id === "notion") return !!(c.token && c.parentPageId);
  return !!c.token;
}
function integrationRow(owner: string, id: IntegrationId) {
  return db().prepare(
    "SELECT data,updated_at AS updatedAt FROM integration_settings WHERE owner=? AND destination=?",
  ).bind(owner, id).first<{ data: string; updatedAt: string }>();
}

const staleConnection = "This connection changed. Reload the page before editing it again.";

async function connectionSnapshot(owner: string, id: IntegrationId, expected: string) {
  const row = await integrationRow(owner, id);
  if (expected !== (row?.updatedAt ?? ""))
    throw new HttpError(409, staleConnection);
  return row;
}

export async function integrationConfig(
  owner: string,
  id: IntegrationId,
): Promise<IntegrationConfig> {
  const row = await integrationRow(owner, id);
  return row
    ? (await open(row.data, owner, id)).config
    : owner === "local_seedy"
      ? envConfig(id)
      : {};
}
export async function integrationStates(
  owner: string,
): Promise<IntegrationStates> {
  const rows = await db()
    .prepare(
      "SELECT destination,data,updated_at AS updatedAt FROM integration_settings WHERE owner=?",
    )
    .bind(owner)
    .all<{ destination: IntegrationId; data: string; updatedAt: string }>();
  const states = {} as IntegrationStates;
  for (const { id } of integrationCatalog) {
    const row = rows.results.find((x) => x.destination === id);
    const saved = row ? await open(row.data, owner, id) : null;
    const config: IntegrationConfig =
      saved?.config ?? (owner === "local_seedy" ? envConfig(id) : {});
    const { site, email, projectKey, issueType, listId, teamId, repository,
      assignees, parentPageId, model, disabled } = config;
    states[id] = {
      configured:
        configured(id, config) &&
        (id !== "webhook" || webhookAllowed(owner, config.webhookUrl!)),
      verified: !!saved?.verified,
      source: row ? "saved" : configured(id, config) ? "environment" : "none",
      updatedAt: row?.updatedAt || "",
      config: { site, email, projectKey, issueType, listId, teamId, repository,
        assignees, parentPageId, model, disabled },
    };
  }
  return states;
}
export async function runtimeConfig(
  owner: string,
  snapshot?: ReadonlyMap<string, string>,
): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    integrationCatalog.map(async ({ id }) => {
      const data = snapshot?.get(id);
      const config = snapshot
        ? data
          ? (await open(data, owner, id)).config
          : owner === "local_seedy"
            ? envConfig(id)
            : {}
        : await integrationConfig(owner, id);
      return [id, config] as const;
    }),
  );
  const c = Object.fromEntries(pairs) as Record<
    IntegrationId,
    IntegrationConfig
  >;
  for (const id of Object.keys(c) as IntegrationId[])
    if (c[id].disabled) c[id] = {};
  return {
    TRACE_WEBHOOK_URL:
      c.webhook.webhookUrl && webhookAllowed(owner, c.webhook.webhookUrl)
        ? c.webhook.webhookUrl
        : "",
    TRACE_WEBHOOK_SECRET: c.webhook.token || "",
    JIRA_CONFIG: JSON.stringify(c.jira),
    TRELLO_CONFIG: JSON.stringify(c.trello),
    LINEAR_API_KEY: c.linear.token || "",
    LINEAR_TEAM_ID: c.linear.teamId || "",
    LINEAR_ASSIGNEES: JSON.stringify(c.linear.assignees || {}),
    GITHUB_TOKEN: c.github.token || "",
    GITHUB_REPOSITORY: c.github.repository || "",
    GITHUB_ASSIGNEES: JSON.stringify(c.github.assignees || {}),
    SLACK_WEBHOOK_URL: c.slack.webhookUrl || "",
    NOTION_API_KEY: c.notion.token || "",
    NOTION_PARENT_PAGE_ID: c.notion.parentPageId || "",
    MEETSTREAM_API_KEY: c.meetstream.token || "",
    ANTHROPIC_API_KEY: c.ai.token || "",
    ANTHROPIC_MODEL: c.ai.model || "claude-sonnet-5-5",
  };
}
export async function discoverIntegration(
  owner: string,
  id: IntegrationId,
  config: unknown,
) {
  const parsed = inputSchema.safeParse(config);
  if (!parsed.success) throw new HttpError(400, "Check the connection fields.");
  const existing = await integrationConfig(owner, id);
  const input = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== ""),
  );
  const c = { ...existing, ...input, disabled: false };
  if (!c.token) throw new HttpError(400, "Paste your API key first.");
  if (id === "linear") return linearOptions(c);
  if (id === "github") return githubOptions(c);
  throw new HttpError(400, "This connection does not require team discovery.");
}
export async function saveIntegration(
  actor: SessionAccess,
  id: IntegrationId,
  input: unknown,
  expected: string,
) {
  const owner = actor.workspace;
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Check the connection fields.");
  const row = await connectionSnapshot(owner, id, expected);
  const existing = row ? (await open(row.data, owner, id)).config
    : owner === "local_seedy" ? envConfig(id) : {};
  const c: IntegrationConfig = {
    ...existing,
    ...Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== ""),
    ),
    disabled: false,
  };
  let verified = false;
  if (id === "linear" || id === "github") {
    if (!c.token) throw new HttpError(400, "Paste your API key first.");
    const options = await (id === "linear" ? linearOptions(c) : githubOptions(c));
    if (id === "linear" && !options.teams.some((t) => t.id === c.teamId))
      throw new HttpError(400, "Choose a team from your Linear workspace.");
    if (
      Object.values(c.assignees || {}).some(
        (value) => !options.users.some((u) => u.id === value),
      )
    )
      throw new HttpError(
        400,
        "An assigned account is unavailable. Load members again and check the owner mappings.",
      );
    verified = true;
  } else if (id === "slack") {
    let url;
    try {
      url = new URL(c.webhookUrl || "");
    } catch {
      throw new HttpError(400, "Paste a valid Slack incoming webhook URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "hooks.slack.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/services\/[A-Za-z0-9_/-]+$/.test(url.pathname)
    )
      throw new HttpError(
        400,
        "Use an HTTPS hooks.slack.com/services/… incoming webhook.",
      );
  } else if (id === "webhook") {
    if (!c.webhookUrl || !webhookAllowed(owner, c.webhookUrl))
      throw new HttpError(
        400,
        "The server operator must allow this HTTPS endpoint for your workspace.",
      );
    if (!c.token || c.token.length < 32)
      throw new HttpError(
        400,
        "Use a webhook signing secret of at least 32 characters.",
      );
  } else if (id === "jira" || id === "trello") {
    try {
      if (id === "jira") {
        const { site, project, authorization } = jiraConnection(c);
        c.site = site;
        c.projectKey = project;
        await providerRead(`${site}/rest/api/3/project/${project}`, { Authorization: authorization });
      } else {
        const { listId, authorization } = trelloConnection(c);
        await providerRead(`https://api.trello.com/1/lists/${listId}`, { Authorization: authorization });
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, (error as Error).message);
    }
    verified = true;
  } else if (id === "notion") {
    const match = (c.parentPageId || "").match(
      /([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:[?#].*)?$/i,
    );
    if (!match)
      throw new HttpError(400, "Paste a Notion page link or page ID.");
    c.parentPageId = match[1];
    if (!c.token) throw new HttpError(400, "Paste the Notion integration key.");
    await providerRead(`https://api.notion.com/v1/pages/${c.parentPageId}`, {
      Authorization: `Bearer ${c.token}`,
      "Notion-Version": "2022-06-28",
    });
    verified = true;
  } else if (!c.token) throw new HttpError(400, "Paste an API key.");
  if (!configured(id, c))
    throw new HttpError(400, "Complete the connection settings.");
  await storeIntegration(
    actor,
    id,
    { config: c, verified },
    "integration.saved",
    row?.updatedAt ?? null,
  );
  return (await integrationStates(owner))[id];
}
export async function disconnectIntegration(actor: SessionAccess, id: IntegrationId, expected: string) {
  const row = await connectionSnapshot(actor.workspace, id, expected);
  await storeIntegration(
    actor,
    id,
    { config: { disabled: true }, verified: false },
    "integration.disconnected",
    row?.updatedAt ?? null,
  );
}

async function storeIntegration(
  actor: SessionAccess,
  id: IntegrationId,
  state: { config: IntegrationConfig; verified: boolean },
  action: string,
  previous: string | null,
) {
  const owner = actor.workspace;
  const data = await seal(state, owner, id);
  const updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous ?? "") || 0) + 1)).toISOString();
  const [write] = await db().batch([
    db()
      .prepare(
        "INSERT INTO integration_settings(id,owner,destination,data,updated_at) SELECT ?,?,?,?,? WHERE " +
        ACTIVE_ADMIN + " AND (SELECT updated_at FROM integration_settings WHERE owner=? AND destination=?) IS ?" +
        " ON CONFLICT(owner,destination) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      )
      .bind(`${owner}:${id}`, owner, id, data, updatedAt, actor.sessionId, owner, owner, id, previous),
    audit(actor, action, id, true),
  ]);
  if (!write.meta.changes) {
    const allowed = await db().prepare("SELECT " + ACTIVE_ADMIN + " AS allowed")
      .bind(actor.sessionId, owner).first<{ allowed: number }>();
    if (!allowed?.allowed) throw new HttpError(403, "Your workspace role no longer allows this action.");
    throw new HttpError(409, staleConnection);
  }
}

function webhookAllowed(workspace: string, endpoint: string) {
  try {
    const url = new URL(endpoint);
    const allowed = JSON.parse(secret("TRACE_WEBHOOK_ENDPOINTS") || "{}")[
      workspace
    ];
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      Array.isArray(allowed) &&
      allowed.includes(endpoint)
    );
  } catch {
    return false;
  }
}
