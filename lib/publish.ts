import { jiraConnection, trelloConnection } from "./work-trackers.ts";
import { safeDeliveryLink } from "./delivery-link.ts";
import { readResponseBytes, readResponseJson } from "./response-body.ts";
import { signWebhook } from "./webhook.ts";
import { isGithubRepository } from "./integration-catalog.ts";
import { meetingPath } from "./navigation.ts";
import {
  adrMarkdown,
  literalMarkdown,
  markdownEvidence,
  evidenceUrl,
  time,
  type Destination,
  type Meeting,
} from "./types.ts";
export const CLAIM_SQL =
  "INSERT INTO deliveries(id,owner,meeting_id,item_id,destination,status,url,error,created_at) SELECT ?,?,?,?,?,'pending','','',? WHERE EXISTS (SELECT 1 FROM meetings WHERE owner=? AND id=? AND revision=?) ON CONFLICT DO NOTHING";
export const PUBLISH_ACCESS_SQL = ` AND EXISTS (
    SELECT 1 FROM sessions
    LEFT JOIN members ON members.id=sessions.actor AND members.workspace=sessions.owner
    WHERE sessions.id=? AND sessions.owner=? AND sessions.expires>unixepoch()
      AND (members.role IN ('admin','reviewer') OR (
        sessions.actor IS NULL AND sessions.owner='local_seedy'
        AND NOT EXISTS (SELECT 1 FROM members WHERE workspace=sessions.owner AND role='admin')
      ))
  ) AND (SELECT data FROM integration_settings WHERE owner=? AND destination=?) IS ?`;
export const AUTHORIZED_CLAIM_SQL = CLAIM_SQL.replace(
  " ON CONFLICT",
  PUBLISH_ACCESS_SQL + " ON CONFLICT",
);
export function deliveryMarker(meetingId: string, itemId: string, destination: Destination) {
  return `trace:${encodeURIComponent(meetingId)}:${encodeURIComponent(itemId)}:${destination}`;
}
export function issueTarget(config: Record<string, string>, destination: Destination) {
  return destination === "linear" ? config.LINEAR_TEAM_ID
    : destination === "github" ? config.GITHUB_REPOSITORY?.toLowerCase() : null;
}
export const PUBLISH_BATCH_SIZE = 4;
export function planDeliveries(m: Meeting, destinations: Destination[]) {
  const plan: { itemId: string; destination: Destination }[] = [];
  for (const destination of new Set(destinations)) {
    if (["linear", "github", "jira", "trello"].includes(destination))
      for (const a of m.actions.filter((a) => a.approved &&
        (destination === "linear" ? a.linearFollowup?.kind !== "ambiguous" : !a.linearFollowup)))
        plan.push({ itemId: a.id, destination });
    if (destination === "notion")
      for (const d of m.discussions.filter((d) => d.approved))
        plan.push({ itemId: d.id, destination });
    if (
      (destination === "slack" || destination === "webhook") &&
      [...m.discussions, ...m.actions].some((x) => x.approved)
    )
      plan.push({ itemId: "summary", destination });
  }
  return plan;
}
export function slackPayload(m: Meeting, origin: string) {
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const link = (id: string) =>
    `<${evidenceUrl(origin, m, id)}|${time(m.segments.find((s) => s.id === id)!.start)} evidence>`;
  const lines = [
    "*Discussions*",
    ...m.discussions
      .filter((d) => d.approved)
      .map((d) => `• ${escape(d.title)} · ${link(d.evidence[0])}`),
    "",
    "*Action items*",
    ...m.actions
      .filter((a) => a.approved)
      .map(
        (a) =>
          `• ${escape(a.title)} — ${escape(a.owner || "Unassigned")}${a.due ? ` · due ${a.due}` : ""} · ${link(a.evidence[0])}`,
      ),
  ];
  const chunks: string[] = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 2800) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 47)
    throw new Error(
      "This Slack summary is too large. Approve fewer outputs or export the meeting instead.",
    );
  return {
    text: "Reviewed engineering meeting",
    link_names: false,
    unfurl_links: false,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: m.title.slice(0, 150), emoji: false },
      },
      ...chunks.map((text) => ({
        type: "section",
        text: { type: "mrkdwn", text, verbatim: true },
      })),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${origin}${meetingPath(m.id)}|Review meeting> · trace:${m.id}:summary:slack`,
          },
        ],
      },
    ],
  };
}
export function assignee(mapping: string, name: string) {
  let parsed;
  try {
    parsed = JSON.parse(mapping || "{}");
  } catch {
    throw new Error("The server owner mapping is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Owner mappings must be a JSON object.");
  const id = parsed[name];
  return typeof id === "string" ? id.trim() : "";
}
export function preflight(
  m: Meeting,
  destinations: Destination[],
  config: Record<string, string>,
) {
  if (m.source === "sample")
    throw new Error(
      "Sample meetings stay in Trace. Import a real transcript to publish to your tools.",
    );
  const actions = m.actions.filter((a) => a.approved);
  for (const dest of destinations) {
    if (dest === "jira") jiraConnection(JSON.parse(config.JIRA_CONFIG || "{}"));
    if (dest === "trello") trelloConnection(JSON.parse(config.TRELLO_CONFIG || "{}"));
    if (dest === "linear") {
      if (!config.LINEAR_API_KEY || !config.LINEAR_TEAM_ID)
        throw new Error("Connect Linear first.");
      actions.filter((a) => !a.linearFollowup).forEach((a) => assignee(config.LINEAR_ASSIGNEES, a.owner));
    }
    if (dest === "github") {
      if (
        !config.GITHUB_TOKEN ||
        !isGithubRepository(config.GITHUB_REPOSITORY || "")
      )
        throw new Error("Connect a valid GitHub repository first.");
      actions.forEach((a) => assignee(config.GITHUB_ASSIGNEES, a.owner));
    }
    if (
      dest === "slack" &&
      !/^https:\/\/hooks\.slack\.com\/services\//.test(
        config.SLACK_WEBHOOK_URL || "",
      )
    )
      throw new Error("Connect a Slack incoming webhook first.");
    if (
      dest === "notion" &&
      (!config.NOTION_API_KEY || !config.NOTION_PARENT_PAGE_ID)
    )
      throw new Error("Connect Notion first.");
  }
  if (
    destinations.includes("webhook") &&
    (!config.TRACE_WEBHOOK_URL || !config.TRACE_WEBHOOK_SECRET)
  )
    throw new Error("Connect an allowed signed webhook first.");
  if (destinations.includes("slack")) slackPayload(m, "https://trace.example");
  if (!planDeliveries(m, destinations).length)
    throw new Error(
      "Approve at least one output for the selected destinations.",
    );
}
function deliveryLink(value: string, destination: Destination) {
  const url = safeDeliveryLink(value, destination);
  if (url) return url;
  throw new Error(
    "The destination returned an invalid link. Check the destination before reconciling.",
  );
}
async function request(url: string, init: RequestInit) {
  // ponytail: no automatic retries for external writes. Ambiguous outcomes require reconciliation.
  const r = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok)
    throw new Error(
      `The destination returned HTTP ${r.status}. Check the destination before attempting any manual reconciliation.`,
    );
  return r;
}
export async function deliver(
  m: Meeting,
  itemId: string,
  destination: Destination,
  origin: string,
  c: Record<string, string>,
  deliveryId?: string,
): Promise<string> {
  if (destination === "webhook") {
    if (!deliveryId) throw new Error("Missing delivery ID.");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const discussions = m.discussions.filter((item) => item.approved);
    const actions = m.actions.filter((item) => item.approved);
    const evidence = new Set(
      [...discussions, ...actions].flatMap((item) => item.evidence),
    );
    const body = JSON.stringify({
      event: "meeting.reviewed",
      id: deliveryId,
      meeting: {
        id: m.id,
        title: m.title,
        revision: m.revision,
        url: origin + meetingPath(m.id),
      },
      discussions,
      actions,
      evidence: m.segments
        .filter((s) => evidence.has(s.id))
        .map((s) => ({ ...s, url: evidenceUrl(origin, m, s.id) })),
    });
    await request(c.TRACE_WEBHOOK_URL, {
      method: "POST",
      redirect: "manual",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Delivery": deliveryId,
        "X-Trace-Timestamp": timestamp,
        "X-Trace-Signature": await signWebhook(
          c.TRACE_WEBHOOK_SECRET,
          deliveryId,
          timestamp,
          body,
        ),
      },
    });
    return "";
  }
  const marker = deliveryMarker(m.id, itemId, destination);
  if (["linear", "github", "jira", "trello"].includes(destination)) {
    const a = m.actions.find((a) => a.id === itemId)!;
    if (a.linearFollowup) throw new Error("Use the existing Linear issue for this follow-up.");
    const body = `${literalMarkdown(a.description)}\n\nMeeting owner: ${literalMarkdown(a.owner || "Unassigned")}${a.due ? `\nDue: ${a.due}` : ""}\n\n## Evidence\n${a.evidence
      .map((id) => markdownEvidence(origin, m, id))
      .join("\n")}\n\n${marker}`;
    if (destination === "jira") {
      const { site, project, issueType, authorization } = jiraConnection(JSON.parse(c.JIRA_CONFIG || "{}"));
      const lines = [a.description, `Meeting owner: ${a.owner || "Unassigned"}`];
      if (a.due) lines.push(`Due: ${a.due}`);
      for (const id of a.evidence) {
        const source = m.segments.find((segment) => segment.id === id)!;
        lines.push(`${time(source.start)} · ${source.speaker}: ${source.text}`, evidenceUrl(origin, m, id));
      }
      lines.push(marker);
      const response = await request(`${site}/rest/api/3/issue`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
          project: { key: project },
          issuetype: { name: issueType },
          summary: a.title.slice(0, 255),
          description: { type: "doc", version: 1, content: lines.filter(Boolean).map((line) => ({
            type: "paragraph", content: [{
              type: "text", text: line.replace(/\r?\n/g, " "),
              ...(line.startsWith(origin + meetingPath(m.id) + "?segment=")
                ? { marks: [{ type: "link", attrs: { href: line } }] } : {}),
            }],
          })) },
        } }),
      });
      const data = await readResponseJson(response) as { key?: string };
      if (!data.key || !/^[A-Z][A-Z0-9]*-\d+$/i.test(data.key))
        throw new Error("Jira did not confirm the issue key.");
      return deliveryLink(`${site}/browse/${data.key}`, destination);
    }
    if (destination === "trello") {
      const { listId, authorization } = trelloConnection(JSON.parse(c.TRELLO_CONFIG || "{}"));
      const response = await request("https://api.trello.com/1/cards", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          idList: listId, name: a.title.slice(0, 256), desc: body,
          ...(a.due ? { due: a.due + "T12:00:00Z" } : {}),
        }),
      });
      const data = await readResponseJson(response) as { url?: string };
      return deliveryLink(data.url || "", destination);
    }
    if (destination === "linear") {
      const mappedOwner = assignee(c.LINEAR_ASSIGNEES, a.owner);
      const issue = {
        ...(deliveryId ? { id: deliveryId } : {}),
        teamId: c.LINEAR_TEAM_ID,
        ...(mappedOwner ? { assigneeId: mappedOwner } : {}),
        title: a.title,
        description: body,
        priority: a.priority === "High" ? 2 : a.priority === "Medium" ? 3 : 4,
        ...(a.due ? { dueDate: a.due } : {}),
      };
      const r = await request("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: c.LINEAR_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            "mutation CreateIssue($input:IssueCreateInput!){issueCreate(input:$input){success issue{id url assignee{id}}}}",
          variables: { input: issue },
        }),
      });
      const data = (await readResponseJson(r)) as {
        errors?: unknown[];
        data?: {
          issueCreate?: {
            success: boolean;
            issue?: { url: string; assignee?: { id: string } | null };
          };
        };
      };
      if (
        data.errors?.length ||
        !data.data?.issueCreate?.success ||
        !data.data.issueCreate.issue?.url
      )
        throw new Error(
          "Linear did not confirm issue creation. Check Linear for the Trace marker before reconciling.",
        );
      if (mappedOwner && data.data.issueCreate.issue.assignee?.id !== mappedOwner)
        throw new Error(
          "Linear created the issue but did not confirm the assignee. Check Linear and reconcile the delivery.",
        );
      return deliveryLink(data.data.issueCreate.issue.url, destination);
    }
    const mappedOwner = assignee(c.GITHUB_ASSIGNEES, a.owner);
    const r = await request(
      `https://api.github.com/repos/${c.GITHUB_REPOSITORY}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Trace-Discussion-Agent",
        },
        body: JSON.stringify({
          title: a.title,
          body,
          ...(mappedOwner ? { assignees: [mappedOwner] } : {}),
        }),
      },
    );
    const data = (await readResponseJson(r)) as {
      html_url: string;
      assignees?: { login: string }[];
    };
    if (!data.html_url)
      throw new Error(
        "GitHub did not return an issue URL. Reconcile before retrying.",
      );
    if (
      mappedOwner && !data.assignees?.some(
        (x) =>
          x.login.toLowerCase() ===
          mappedOwner.toLowerCase(),
      )
    )
      throw new Error(
        "GitHub created the issue but did not confirm the assignee. Check the repository and reconcile the delivery.",
      );
    return deliveryLink(data.html_url, destination);
  }
  if (destination === "slack") {
    // Escape Slack control syntax; only evidence links constructed here can become links.
    const response = await request(c.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload(m, origin)),
    });
    if (
      new TextDecoder()
        .decode(await readResponseBytes(response, 256))
        .trim() !== "ok"
    )
      throw new Error(
        "Slack did not confirm the summary. Check the channel before reconciling.",
      );
    return "";
  }
  const d = m.discussions.find((d) => d.id === itemId)!;
  const markdown = adrMarkdown(m, d, origin, (text) => text);
  const chunks = markdown.match(/[\s\S]{1,1800}/g) || [];
  const r = await request("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: c.NOTION_PARENT_PAGE_ID },
      properties: {
        title: {
          type: "title",
          title: [{ type: "text", text: { content: d.title } }],
        },
      },
      children: [
        ...chunks.map((text) => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
        })),
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: marker } }],
          },
        },
      ],
    }),
  });
  const data = (await readResponseJson(r)) as { url: string };
  if (!data.url)
    throw new Error(
      "Notion did not return a page URL. Reconcile before retrying.",
    );
  return deliveryLink(data.url, destination);
}
