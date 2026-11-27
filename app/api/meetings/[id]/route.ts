import { extractLinearFollowups } from "@/lib/linear-followups";
import { linearHistory } from "@/lib/linear-history";
import { integrationConfig } from "@/lib/integration-service";
import {
  db,
  access,
  audit,
  guard,
  body,
  failure,
  getMeeting,
  HttpError,
} from "@/lib/server";
import { z } from "zod";
import { can, type Access } from "@/lib/access";
import { meetingSchema, type Meeting } from "@/lib/types";
import { correctMeeting, correctionSchema } from "@/lib/review-corrections";

const stale = "This meeting was updated elsewhere. Reload before saving your changes.";
const correctionInput = correctionSchema.or(z.object({ kind: z.literal("refreshLinear") })).and(z.object({ revision: z.number().int().min(0) }));

async function saveMeeting(
  a: Access,
  meeting: Meeting,
  event: string,
  protectedIds: string[] = [],
) {
  const next = { ...meeting, revision: meeting.revision + 1 };
  // The revision and delivery checks serialize merges against publishing claims.
  const statement = db().prepare(
    "UPDATE meetings SET data=?,revision=? WHERE id=? AND owner=? AND revision=?" +
    (protectedIds.length ? " AND NOT EXISTS (SELECT 1 FROM deliveries WHERE owner=? AND meeting_id=? AND item_id IN (SELECT value FROM json_each(?)))" : ""),
  ).bind(
    JSON.stringify(next), next.revision, meeting.id, a.workspace, meeting.revision,
    ...(protectedIds.length ? [a.workspace, meeting.id, JSON.stringify(protectedIds)] : []),
  );
  const [update] = await db().batch([statement, audit(a, event, meeting.id, true)]);
  if (!update.meta.changes) {
    if (protectedIds.length && (await getMeeting(a.workspace, meeting.id)).revision === meeting.revision)
      throw new HttpError(409, "Publishing activity changed. Open Activity before editing these drafts.");
    throw new HttpError(409, stale);
  }
  return Response.json({ meeting: next });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await access(req);
    const { id } = await params;
    return Response.json({ meeting: await getMeeting(workspace, id) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    guard(req);
    const a = await access(req, "review");
    const { id } = await params;
    const current = await getMeeting(a.workspace, id);
    const parsed = correctionInput.safeParse(await body(req));
    if (!parsed.success) throw new HttpError(400, "Check the correction and try again.");
    const correction = parsed.data;
    if (correction.revision !== current.revision) throw new HttpError(409, stale);
    if (correction.kind === "refreshLinear") {
      const config = await integrationConfig(a.workspace, "linear");
      const history = await linearHistory(a.workspace, config.disabled ? "" : config.teamId || "", current.date, current.id);
      const { results } = await db().prepare(
        "SELECT item_id AS itemId FROM deliveries WHERE owner=? AND meeting_id=?",
      ).bind(a.workspace, id).all<{ itemId: string }>();
      const locked = new Set(results.map((row) => row.itemId));
      const unchanged = current.actions.filter((item) => locked.has(item.id) || item.linearFollowup?.kind === "issue");
      const drafts = current.actions.filter((item) => !unchanged.includes(item));
      const next = extractLinearFollowups(drafts, current.segments, current.project, history);
      const prior = new Map(drafts.map((item) => [item.id, item]));
      const remembered = new Set(unchanged.flatMap((item) =>
        item.linearFollowup?.kind === "issue" ? [item.linearFollowup.deliveryId] : []));
      const updated = [...unchanged, ...next.filter((item) =>
        item.linearFollowup?.kind !== "issue" || !remembered.has(item.linearFollowup.deliveryId))
        .map((item) => JSON.stringify(item) === JSON.stringify(prior.get(item.id)) ? item : {
          ...item, id: unchanged.some((existing) => existing.id === item.id) ? crypto.randomUUID() : item.id, approved: false,
        })];
      const order = new Map(current.actions.map((item, index) => [item.id, index]));
      updated.sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity));
      if (JSON.stringify(updated) === JSON.stringify(current.actions)) return Response.json({ meeting: current });
      const refreshed = meetingSchema.safeParse({ ...current, actions: updated, reviewed: false });
      if (!refreshed.success) throw new HttpError(409, "This meeting’s Linear matches exceed its draft limits.");
      return saveMeeting(a, refreshed.data, "meeting.linear_history_refreshed",
        drafts.map((item) => item.id));
    }
    const next = correctMeeting(current, correction);
    if (next === current) return Response.json({ meeting: current });
    return await saveMeeting(a, next, `meeting.corrected:${correction.kind}`,
      correction.kind === "merge" ? [correction.keepId, correction.removeId] : undefined);
  } catch (e) {
    return failure(e);
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    guard(req);
    const a = await access(req, "edit");
    const owner = a.workspace;
    const { id } = await params;
    const current = await getMeeting(owner, id);
    const result = meetingSchema.safeParse(await body(req));
    if (!result.success)
      throw new HttpError(
        400,
        "Draft is invalid. Check the owners and evidence links.",
      );
    const m = result.data;
    if (m.revision !== current.revision)
      throw new HttpError(
        409,
        stale,
      );
    if (
      m.id !== id ||
      JSON.stringify(m.segments) !== JSON.stringify(current.segments) ||
      m.source !== current.source
    )
      throw new HttpError(
        400,
        "Transcript and source metadata cannot be changed during review.",
      );
    const ids = (items: { id: string }[]) =>
      JSON.stringify(items.map((x) => x.id).sort());
    if (
      ids(m.actions) !== ids(current.actions) ||
      ids(m.discussions) !== ids(current.discussions)
    )
      throw new HttpError(
        400,
        "Output identities cannot be changed during review.",
      );
    const previous = new Map(
      [...current.actions, ...current.discussions].map((item) => [item.id, item]),
    );
    const outputs = [...m.actions, ...m.discussions];
    const existingOwners = new Map(current.actions.map((item) => [item.id, item.owner]));
    if (m.actions.some((item) => item.owner && item.owner !== existingOwners.get(item.id) &&
      !current.segments.some((segment) => segment.speaker === item.owner)))
      throw new HttpError(400, "Choose a current meeting participant as the owner.");
    if (m.actions.some((item) => JSON.stringify(item.linearFollowup) !==
      JSON.stringify(current.actions.find((previous) => previous.id === item.id)?.linearFollowup)))
      throw new HttpError(400, "A Linear follow-up must come from the meeting’s evidence and issue history.");
    const reviewChanged =
      m.reviewed !== current.reviewed ||
      outputs.some((item) => item.approved !== previous.get(item.id)?.approved);
    function reviewContent(meeting: typeof m) {
      return {
        ...meeting,
        actions: meeting.actions.map((action) => ({
          ...action,
          completed: false,
        })),
      };
    }
    const before = reviewContent(current);
    const after = reviewContent(m);
    if (!can(a.role, "review")) {
      const acceptedActions = before.actions.filter((item) => item.approved);
      const acceptedDiscussions = before.discussions.filter(
        (item) => item.approved,
      );
      if (
        reviewChanged ||
        JSON.stringify(acceptedActions) !==
          JSON.stringify(after.actions.filter((item) => item.approved)) ||
        JSON.stringify(acceptedDiscussions) !==
          JSON.stringify(after.discussions.filter((item) => item.approved)) ||
        (current.reviewed && JSON.stringify(before) !== JSON.stringify(after))
      )
        throw new HttpError(
          403,
          "A reviewer must approve or change accepted outputs.",
        );
    }
    return await saveMeeting(a, m, reviewChanged ? "meeting.review_changed" : "meeting.edited");
  } catch (e) {
    return failure(e);
  }
}
