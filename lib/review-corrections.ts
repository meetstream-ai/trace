import { z } from "zod";
import { HttpError } from "./errors.ts";
import { meetingSchema, type Action, type Discussion, type Meeting } from "./types.ts";

const itemId = z.string().min(1).max(100);
const title = z.string().trim().min(1).max(300);
export const correctionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discussion"), segmentId: itemId, title }),
  z.object({ kind: z.literal("action"), segmentId: itemId, title, owner: z.string().trim().max(120) }),
  z.object({ kind: z.literal("speaker"), segmentId: itemId, speaker: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal("merge"), keepId: itemId, removeId: itemId }),
]);
export type Correction = z.infer<typeof correctionSchema>;

export function correctMeeting(meeting: Meeting, correction: Correction): Meeting {
  let next = { ...meeting, reviewed: false };
  if (correction.kind === "merge") {
    const { keepId, removeId } = correction;
    function merge<T extends Action | Discussion>(items: T[]) {
      const keep = items.find((item) => item.id === keepId);
      const remove = items.find((item) => item.id === removeId);
      if (!keep || !remove || keepId === removeId) return null;
      if (("linearFollowup" in keep && keep.linearFollowup) || ("linearFollowup" in remove && remove.linearFollowup))
        throw new HttpError(400, "Linear follow-ups are already grouped by issue.");
      const evidence = [...new Set([...keep.evidence, ...remove.evidence])];
      if (evidence.length > 20)
        throw new HttpError(400, "A merged draft can have up to 20 evidence links.");
      return items.filter((item) => item.id !== removeId).map((item) =>
        item.id === keepId ? { ...item, evidence, approved: false } : item,
      );
    }
    const discussions = merge(meeting.discussions);
    const actions = merge(meeting.actions);
    if (!discussions && !actions)
      throw new HttpError(400, "Choose two different drafts of the same kind.");
    next = { ...next, discussions: discussions ?? meeting.discussions, actions: actions ?? meeting.actions };
  } else {
    const turn = meeting.segments.find((item) => item.id === correction.segmentId);
    if (!turn) throw new HttpError(404, "Transcript turn not found.");
    if (correction.kind === "speaker") {
      if (turn.speaker === correction.speaker) return meeting;
      const original = turn.previousSpeakers?.[0] ?? turn.speaker;
      const owners = new Set(meeting.actions.map((item) => item.owner));
      const previousSpeakers = [
        ...new Set([
          original,
          ...[...(turn.previousSpeakers ?? []), turn.speaker].filter((name) => owners.has(name)),
        ]),
      ];
      const reopen = <T extends Action | Discussion>(items: T[]) =>
        items.map((item) => item.evidence.includes(turn.id) ? { ...item, approved: false } : item);
      next.segments = meeting.segments.map((item) => item.id === turn.id ? {
        ...item,
        speaker: correction.speaker,
        previousSpeakers,
      } : item);
      next.actions = reopen(meeting.actions);
      next.discussions = reopen(meeting.discussions);
    } else {
      const draft = {
        id: crypto.randomUUID(),
        title: correction.title,
        evidence: [turn.id],
        approved: false,
      };
      const excerpt = turn.text.slice(0, 4000);
      if (correction.kind === "discussion")
        next.discussions = [...meeting.discussions, { ...draft, context: excerpt, rationale: "", consequences: "" }];
      else {
        if (correction.owner && !meeting.segments.some((item) => item.speaker === correction.owner))
          throw new HttpError(400, "Choose a current meeting participant as the owner.");
        next.actions = [...meeting.actions, {
          ...draft, owner: correction.owner, description: excerpt, due: "", priority: "Medium", completed: false,
        }];
      }
    }
  }
  const result = meetingSchema.safeParse(next);
  if (!result.success) throw new HttpError(400, "This correction exceeds the meeting’s draft limits.");
  return result.data;
}
