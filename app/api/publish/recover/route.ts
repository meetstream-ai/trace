import { originalLinearIssue } from "@/lib/linear-history";
import { readLinearFollowup, setLinearFollowupStatus } from "@/lib/linear-status";
import { z } from "zod";
import { runtimeConfig } from "@/lib/integration-service";
import { findDeliveredIssue } from "@/lib/issue-recovery";
import { deliver, issueTarget, PUBLISH_ACCESS_SQL, preflight } from "@/lib/publish";
import { accessWithSession, audit, body, db, failure, getDeliveries, getMeeting, guard, HttpError, secret } from "@/lib/server";

const input = z.object({
  deliveryId: z.uuid(),
  action: z.enum(["check", "retry"]),
  revision: z.number().int().min(0),
});
const waitBeforeRetry = 90_000;

export async function POST(req: Request) {
  try {
    guard(req);
    const a = await accessWithSession(req, "review");
    const parsed = input.safeParse(await body(req));
    if (!parsed.success) throw new HttpError(400, "Select an issue delivery to check.");
    const { action, deliveryId, revision } = parsed.data;
    const row = await db().prepare(
      `SELECT id,meeting_id AS meetingId,item_id AS itemId,destination,status,
        issue_target AS target,followup_of AS followupOf,attempted_at AS attemptedAt,created_at AS createdAt
        FROM deliveries WHERE owner=? AND id=? AND destination IN ('linear','github')`,
    ).bind(a.workspace, deliveryId).first<{
      id: string; meetingId: string; itemId: string; destination: "linear" | "github";
      status: string; target: string | null; followupOf: string | null; attemptedAt: number | null; createdAt: string;
    }>();
    if (!row) throw new HttpError(404, "Issue delivery not found.");
    const respond = async (outcome: string, canRetry = false, message = "") =>
      Response.json({ outcome, canRetry, message, deliveries: await getDeliveries(a.workspace) });
    if (row.status === "sent") return await respond("found", false, "Issue already linked.");
    const elapsed = Date.now() - (row.attemptedAt ?? Date.parse(row.createdAt));
    if (row.status === "pending" && elapsed < waitBeforeRetry)
      throw new HttpError(409, "An issue attempt may still be running. Check again shortly.");

    const connection = await db().prepare("SELECT data FROM integration_settings WHERE owner=? AND destination=?")
      .bind(a.workspace, row.destination).first<{ data: string }>();
    const config = await runtimeConfig(a.workspace, new Map([[row.destination, connection?.data ?? ""]]));
    const target = issueTarget(config, row.destination);
    if (row.target && row.target !== target)
      throw new HttpError(409, "Reconnect the original team or repository to check this delivery.");
    const meeting = await getMeeting(a.workspace, row.meetingId);
    const item = meeting.actions.find((action) => action.id === row.itemId);
    let followup: { url: string; issueId: string; stateId: string } | undefined;
    if (row.followupOf) {
      if (!item || item.linearFollowup?.kind !== "issue" || item.linearFollowup.deliveryId !== row.followupOf)
        throw new HttpError(409, "This Linear follow-up no longer has a verified original issue.");
      const original = await originalLinearIssue(a.workspace, config.LINEAR_TEAM_ID, item);
      try {
        const change = await readLinearFollowup(config, original.identifier, item.linearFollowup.status);
        followup = { url: original.url, issueId: change.issue.id, stateId: change.stateId };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, "Could not verify the Linear issue status. Try again.");
      }
    }
    const match = followup ? (followup.stateId ? null : followup.url) : await findDeliveredIssue(row, config);
    const authorized = [a.sessionId, a.workspace, a.workspace, row.destination, connection?.data ?? null] as const;
    const snapshot = [row.id, a.workspace, row.status, row.attemptedAt] as const;
    const sameAttempt = " WHERE id=? AND owner=? AND status=? AND attempted_at IS ?";
    if (match) {
      const [update] = await db().batch([
        db().prepare("UPDATE deliveries SET status='sent',url=?,error=''" + sameAttempt + PUBLISH_ACCESS_SQL)
          .bind(match, ...snapshot, ...authorized),
        audit(a, `delivery.recovered:${row.destination}`, row.meetingId, true),
      ]);
      if (!update.meta.changes)
        throw new HttpError(409, "The delivery or connection changed. Refresh and check again.");
      return await respond("found", false, followup ? "Confirmed the issue status in Linear." :
        "Existing issue linked. Check its assignee in the destination.");
    }

    const approved = !!item?.approved;
    const paused = secret("TRACE_PAUSE_PUBLISHING") === "1";
    const canRetry = !!row.target && elapsed >= waitBeforeRetry && approved && !paused;
    const explanation = !row.target ? "Trace did not record the original destination for this older attempt. Verify the issue in the destination."
      : elapsed < waitBeforeRetry ? "Check again in a moment to allow for a delayed issue."
      : !approved ? "Review and approve this action again to retry."
      : paused ? "Publishing is paused."
      : followup ? "Review the issue in Linear before trying the status update again."
      : "Confirm in the destination that the issue is absent before retrying.";
    if (action === "check") return await respond("missing", canRetry,
      (followup ? "The proposed status is not set. " : "No matching issue found. ") + explanation);
    if (!canRetry) throw new HttpError(409, explanation);
    if (meeting.revision !== revision)
      throw new HttpError(409, "The meeting changed. Reload and review the latest draft before retrying.");
    try {
      preflight(meeting, [row.destination], config);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    const attemptedAt = Date.now();
    const [claim] = await db().batch([
      db().prepare("UPDATE deliveries SET status='pending',attempted_at=?,error=''" +
        sameAttempt + " AND EXISTS (SELECT 1 FROM meetings WHERE owner=? AND id=? AND revision=?)" + PUBLISH_ACCESS_SQL)
        .bind(attemptedAt, ...snapshot, a.workspace, meeting.id, meeting.revision, ...authorized),
      audit(a, `delivery.retried:${row.destination}`, meeting.id, true),
    ]);
    if (!claim.meta.changes) throw new HttpError(409, "The delivery, meeting, or connection changed. Refresh and check again.");

    let url: string;
    try {
      if (followup) {
        await setLinearFollowupStatus(config, followup.issueId, followup.stateId);
        url = followup.url;
      } else {
        url = await deliver(meeting, row.itemId, row.destination, new URL(req.url).origin, config, row.id);
      }
    } catch {
      await db().batch([
        db().prepare("UPDATE deliveries SET status='uncertain' WHERE id=? AND owner=? AND status='pending' AND attempted_at=?")
          .bind(row.id, a.workspace, attemptedAt),
        audit(a, `delivery.uncertain:${row.destination}`, meeting.id, true),
      ]);
      return await respond("uncertain", false, "The retry could not be confirmed. Check the destination again before retrying.");
    }
    await db().batch([
      db().prepare("UPDATE deliveries SET status='sent',url=?,error='' WHERE id=? AND owner=? AND status='pending' AND attempted_at=?")
        .bind(url, row.id, a.workspace, attemptedAt),
      audit(a, `delivery.sent:${row.destination}`, meeting.id, true),
    ]);
    return await respond("sent", false, followup ? "Linear status updated." : "Issue published.");
  } catch (error) {
    return failure(error);
  }
}
