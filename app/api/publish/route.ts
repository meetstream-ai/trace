import { linearHistory, originalLinearIssue } from "@/lib/linear-history";
import { linearTitleKey, matchLinearIssue } from "@/lib/linear-followups";
import { readLinearFollowup, setLinearFollowupStatus } from "@/lib/linear-status";
import { destinations } from "@/lib/types";
import { runtimeConfig } from "@/lib/integration-service";
import { z } from "zod";
import {
  db,
  accessWithSession,
  secret,
  audit,
  guard,
  body,
  failure,
  getMeeting,
  getDeliveries,
  HttpError,
} from "@/lib/server";
import {
  AUTHORIZED_CLAIM_SQL,
  PUBLISH_BATCH_SIZE,
  planDeliveries,
  preflight,
  deliver,
  issueTarget,
} from "@/lib/publish";
const input = z.object({
  meetingId: z.string().min(1).max(100),
  revision: z.number().int(),
  itemIds: z.array(z.string().min(1).max(100)).min(1).max(300).optional(),
  destinations: z
    .array(z.enum(destinations))
    .min(1)
    .max(destinations.length),
});
export async function POST(req: Request) {
  try {
    guard(req);
    const a = await accessWithSession(req, "review");
    if (secret("TRACE_PAUSE_PUBLISHING") === "1")
      throw new HttpError(
        503,
        "Publishing is paused by the workspace operator.",
      );
    const owner = a.workspace;
    const p = input.safeParse(await body(req));
    if (!p.success)
      throw new HttpError(
        400,
        "Select a meeting and at least one destination.",
      );
    const m = await getMeeting(owner, p.data.meetingId);
    if (m.revision !== p.data.revision)
      throw new HttpError(
        409,
        "The meeting changed. Reload and review the latest draft before publishing.",
      );
    const itemIds = p.data.itemIds && new Set(p.data.itemIds);
    if (itemIds && [...itemIds].some((id) => ![...m.actions, ...m.discussions].some((item) => item.id === id)))
      throw new HttpError(400, "A selected draft no longer exists.");
    const publishing = itemIds ? {
      ...m,
      actions: m.actions.filter((item) => itemIds.has(item.id)),
      discussions: m.discussions.filter((item) => itemIds.has(item.id)),
    } : m;
    const settings = await db()
      .prepare(
        "SELECT destination,data FROM integration_settings WHERE owner=?",
      )
      .bind(owner)
      .all<{ destination: string; data: string }>();
    const connection = new Map(
      settings.results.map((row) => [row.destination, row.data]),
    );
    const c = await runtimeConfig(owner, connection);
    try {
      preflight(publishing, p.data.destinations, c);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    const plan = planDeliveries(publishing, p.data.destinations);
    const claims = await db()
      .prepare(
        "SELECT item_id AS itemId, destination FROM deliveries WHERE owner=? AND meeting_id=?",
      )
      .bind(owner, m.id)
      .all<{ itemId: string; destination: string }>();
    const key = (item: { itemId: string; destination: string }) =>
      JSON.stringify([item.destination, item.itemId]);
    const existing = new Set(claims.results.map(key));
    const pending = plan.filter((item) => !existing.has(key(item)));
    const history = pending.some((row) => row.destination === "linear")
      ? await linearHistory(owner, c.LINEAR_TEAM_ID, m.date, m.id) : [];
    for (const item of pending.filter((row) => row.destination === "linear")) {
      const action = publishing.actions.find((row) => row.id === item.itemId)!;
      if (!action.linearFollowup && matchLinearIssue(action.title, m.project, history).length)
        throw new HttpError(409, "This action now matches earlier Linear work. Check Linear history from the meeting before publishing.");
    }
    let sent = 0;
    let skipped = plan.length - pending.length;
    for (const item of pending.slice(0, PUBLISH_BATCH_SIZE)) {
      const id = crypto.randomUUID();
      const action = item.destination === "linear" ? publishing.actions.find((row) => row.id === item.itemId) : undefined;
      const followup = action?.linearFollowup?.kind === "issue" ? action.linearFollowup : undefined;
      const titleKey = action && !followup ? linearTitleKey(action.title) : "";
      const linearKey = titleKey ? JSON.stringify([m.project.trim().toLowerCase(), titleKey]) : null;
      const original = followup && action ? await originalLinearIssue(owner, c.LINEAR_TEAM_ID, action) : undefined;
      const orderedClaim = followup ? AUTHORIZED_CLAIM_SQL.replace(" ON CONFLICT", ` AND NOT EXISTS (
        SELECT 1 FROM deliveries AS prior WHERE prior.owner=? AND prior.followup_of=?
        AND (prior.status IN ('pending','uncertain') OR julianday(prior.followup_date)>julianday(?))
      ) ON CONFLICT`) : linearKey ? AUTHORIZED_CLAIM_SQL.replace(" ON CONFLICT", ` AND NOT EXISTS (
        SELECT 1 FROM deliveries AS previous WHERE previous.owner=? AND previous.issue_target=? AND previous.linear_key=?
      ) ON CONFLICT`) : AUTHORIZED_CLAIM_SQL;
      const [claim] = await db().batch([
        db()
          .prepare(orderedClaim)
          .bind(
            id,
            owner,
            m.id,
            item.itemId,
            item.destination,
            new Date().toISOString(),
            owner,
            m.id,
            m.revision,
            a.sessionId,
            owner,
            owner,
            item.destination,
            connection.get(item.destination) ?? null,
            ...(followup ? [owner, followup.deliveryId, m.date] : linearKey ? [owner, c.LINEAR_TEAM_ID, linearKey] : []),
          ),
        audit(a, `delivery.claimed:${item.destination}`, m.id, true),
        db().prepare("UPDATE deliveries SET issue_target=?,attempted_at=?,followup_of=?,followup_date=?,linear_key=? WHERE id=? AND owner=?")
          .bind(issueTarget(c, item.destination) || null, Date.now(), followup?.deliveryId ?? null,
            followup ? m.date : null, linearKey, id, owner),
      ]);
      if (!claim.meta.changes) {
        await accessWithSession(req, "review");
        if ((await getMeeting(owner, m.id)).revision !== m.revision)
          throw new HttpError(
            409,
            "The meeting changed. Reload and review the latest draft before continuing. Check Activity for any deliveries already sent.",
          );
        const currentConnection = await db()
          .prepare(
            "SELECT data FROM integration_settings WHERE owner=? AND destination=?",
          )
          .bind(owner, item.destination)
          .first<{ data: string }>();
        if (
          (currentConnection?.data ?? null) !==
          (connection.get(item.destination) ?? null)
        )
          throw new HttpError(
            409,
            "Integration settings changed. Check Activity before continuing.",
          );
        if ((followup || linearKey) && !(await db().prepare(
          "SELECT id FROM deliveries WHERE owner=? AND meeting_id=? AND item_id=? AND destination='linear'",
        ).bind(owner, m.id, item.itemId).first()))
          throw new HttpError(409, followup
            ? "Another follow-up for this Linear issue is pending or comes from a newer meeting. Check Activity before publishing."
            : "Matching Linear work was already sent or is awaiting confirmation. Check Linear history before publishing.");
        skipped++;
        continue;
      }
      let statusChange;
      if (followup && original) {
        try {
          statusChange = await readLinearFollowup(c, original.identifier, followup.status);
          await accessWithSession(req, "review");
          const currentSettings = await db().prepare(
            "SELECT data FROM integration_settings WHERE owner=? AND destination='linear'",
          ).bind(owner).first<{ data: string }>();
          if ((currentSettings?.data ?? null) !== (connection.get("linear") ?? null) ||
              (await getMeeting(owner, m.id)).revision !== m.revision)
            throw new HttpError(409, "The meeting or Linear settings changed. Review the latest draft before publishing.");
        } catch (error) {
          // Only reads have occurred. Release the reservation so a reviewer can try again.
          await db().prepare("DELETE FROM deliveries WHERE id=? AND owner=? AND status='pending'")
            .bind(id, owner).run();
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, "Could not read the existing Linear issue. Check the connection and try again.");
        }
      }
      try {
        if (statusChange) await setLinearFollowupStatus(c, statusChange.issue.id, statusChange.stateId);
        const url = original?.url ?? await deliver(
          publishing,
          item.itemId,
          item.destination,
          new URL(req.url).origin,
          c,
          id,
        );
        await db().batch([
          db()
            .prepare(
              "UPDATE deliveries SET status='sent',url=? WHERE id=? AND owner=?",
            )
            .bind(url, id, owner),
          audit(a, `delivery.sent:${item.destination}`, m.id, true),
        ]);
        sent++;
      } catch {
        await db().batch([
          db()
            .prepare(
              "UPDATE deliveries SET status='uncertain',error=? WHERE id=? AND owner=?",
            )
            .bind(
              "Delivery could not be confirmed. Check the destination before reconciling.",
              id,
              owner,
            ),
          audit(a, `delivery.uncertain:${item.destination}`, m.id, true),
        ]);
      }
    }
    await accessWithSession(req, "review");
    const deliveries = await getDeliveries(owner);
    const recorded = new Set(
      deliveries.filter((delivery) => delivery.meetingId === m.id).map(key),
    );
    return Response.json({
      sent,
      skipped,
      remaining: plan.filter((item) => !recorded.has(key(item))).length,
      deliveries,
    });
  } catch (e) {
    return failure(e);
  }
}
