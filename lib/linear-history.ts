import { safeDeliveryLink } from "./delivery-link.ts";
import { linearIssueIdentifier, type TrackedIssue } from "./linear-followups.ts";
import { db, HttpError } from "./server";
import type { Action } from "./types.ts";

export async function linearHistory(workspace: string, team: string, date: string, meetingId = "") {
  if (!team) return [];
  const { results } = await db().prepare(
    `SELECT d.id,d.url,json_extract(a.value,'$.title') AS title,
      json_extract(m.data,'$.project') AS project
    FROM deliveries AS d JOIN meetings AS m ON m.owner=d.owner AND m.id=d.meeting_id
    JOIN json_each(m.data,'$.actions') AS a ON json_extract(a.value,'$.id')=d.item_id
    WHERE d.owner=? AND d.destination='linear' AND d.issue_target=?
      AND d.status='sent' AND d.followup_of IS NULL AND m.id<>?
      AND julianday(json_extract(m.data,'$.date'))<=julianday(?)
    ORDER BY d.created_at DESC LIMIT 500`,
  ).bind(workspace, team, meetingId, date).all<TrackedIssue>();
  return results.filter((issue) => !!linearIssueIdentifier(issue.url));
}

export async function originalLinearIssue(workspace: string, team: string, action: Action) {
  const followup = action.linearFollowup;
  if (!followup || followup.kind !== "issue")
    throw new HttpError(409, "This follow-up needs a confirmed Linear issue.");
  const root = await db().prepare(
    "SELECT url FROM deliveries WHERE id=? AND owner=? AND destination='linear' AND status='sent' AND issue_target=? AND followup_of IS NULL",
  ).bind(followup.deliveryId, workspace, team).first<{ url: string }>();
  const url = root && safeDeliveryLink(root.url, "linear");
  const identifier = url && linearIssueIdentifier(url);
  if (!identifier || identifier !== followup.identifier)
    throw new HttpError(409, "The original issue is unavailable in this Linear connection. Check the connected team.");
  return { identifier, url };
}
