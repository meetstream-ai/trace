import { meetingPath } from "./navigation.ts";
import { z } from "zod";

export const segmentSchema = z
  .object({
    id: z.string().min(1).max(100),
    speaker: z.string().min(1).max(120),
    previousSpeakers: z.array(z.string().min(1).max(120)).max(201).optional(),
    start: z.number().finite().min(0).max(604800),
    end: z.number().finite().min(0).max(604800),
    text: z.string().min(1).max(12000),
  })
  .refine((s) => s.end >= s.start, "End must follow start");
export const discussionSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  context: z.string().max(4000),
  rationale: z.string().max(4000),
  consequences: z.string().max(4000),
  evidence: z.array(z.string()).min(1).max(20),
  approved: z.boolean().default(false),
});
export const linearStatuses = ["backlog", "unstarted", "started", "completed", "canceled", "duplicate"] as const;
export type LinearStatus = (typeof linearStatuses)[number];
export const actionSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  description: z.string().max(4000),
  owner: z.string().max(120),
  due: z
    .string()
    .refine(
      (v) =>
        !v ||
        (/^\d{4}-\d{2}-\d{2}$/.test(v) &&
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().slice(0, 10) === v),
      "Use a valid YYYY-MM-DD date",
    ),
  priority: z.enum(["High", "Medium", "Low"]),
  evidence: z.array(z.string()).min(1).max(20),
  approved: z.boolean().default(false),
  completed: z.boolean().default(false),
  linearFollowup: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ambiguous") }),
    z.object({
      kind: z.literal("issue"), deliveryId: z.uuid(), url: z.url().max(2048),
      identifier: z.string().max(100), status: z.enum(linearStatuses).nullable(),
    }),
  ]).optional(),
});
export const meetingSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    date: z.string().datetime(),
    project: z.string().max(100),
    platform: z.enum(["Google Meet", "Zoom", "Microsoft Teams", "Transcript"]),
    duration: z.number().finite().min(0).max(604800),
    summary: z.string().max(8000),
    segments: z.array(segmentSchema).min(1).max(5000),
    discussions: z.array(discussionSchema).max(100),
    actions: z.array(actionSchema).max(200),
    questions: z.array(z.string().max(1000)).max(100),
    source: z.enum(["sample", "import", "meetstream"]),
    extraction: z.enum(["sample", "rules", "ai"]),
    reviewed: z.boolean(),
    revision: z.number().int().min(0),
  })
  .superRefine((m, ctx) => {
    const ids = new Set(m.segments.map((s) => s.id));
    if (ids.size !== m.segments.length)
      ctx.addIssue({ code: "custom", message: "Segment IDs must be unique" });
    const outputIds = [...m.discussions, ...m.actions].map((x) => x.id);
    if (new Set(outputIds).size !== outputIds.length)
      ctx.addIssue({ code: "custom", message: "Output IDs must be unique" });
    for (const item of [...m.discussions, ...m.actions]) {
      if (item.evidence.some((id) => !ids.has(id)))
        ctx.addIssue({
          code: "custom",
          message: "Evidence must reference a transcript segment",
        });
      if (
        "owner" in item &&
        item.owner &&
        !m.segments.some((s) => s.speaker === item.owner || s.previousSpeakers?.includes(item.owner))
      )
        ctx.addIssue({
          code: "custom",
          message: "Owner must be a meeting participant",
        });
    }
  });
export const extractionSchema = z.object({
  summary: z.string().max(8000),
  discussions: z.array(discussionSchema).max(100),
  actions: z.array(actionSchema).max(200),
  questions: z.array(z.string().max(1000)).max(100),
});
export type Meeting = z.infer<typeof meetingSchema>;
// Older stored meetings used the previous name. Keep their IDs and review data.
export function readStoredMeeting(data: string, revision: number): Meeting {
  const { decisions, ...meeting } = JSON.parse(data);
  return meetingSchema.parse({
    ...meeting,
    discussions: meeting.discussions ?? decisions,
    revision,
  });
}

export type Segment = z.infer<typeof segmentSchema>;
export type MeetingPreview = Omit<Meeting, "segments"> & {
  turns: Pick<Segment, "id" | "speaker" | "start">[];
};

export function meetingPreview({ segments, ...meeting }: Meeting): MeetingPreview {
  return {
    ...meeting,
    turns: segments.map(({ id, speaker, start }) => ({ id, speaker, start })),
  };
}

export type Discussion = z.infer<typeof discussionSchema>;
export type Action = z.infer<typeof actionSchema>;
export const destinations = ["linear", "github", "jira", "trello", "slack", "notion", "webhook"] as const;
export type Destination = (typeof destinations)[number];
export type Delivery = {
  id: string;
  meetingId: string;
  itemId: string;
  destination: Destination;
  status: "pending" | "sent" | "uncertain";
  url: string;
  error: string;
  createdAt: string;
  followupOf?: string | null;
};
export type IntegrationStatus = Record<
  Destination | "meetstream" | "ai",
  boolean
>;
export type MeetStreamBot = {
  id: string;
  label: string;
  createdAt: number;
  stopRequestedAt: number | null;
  meetingId: string | null;
};
export type MeetStreamBotStatus = {
  label: string;
  canStop: boolean;
  ready: boolean;
  settled: boolean;
};
export const botStopRetryMs = 45_000;

export function time(seconds: number) {
  const n = Math.floor(seconds);
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
}
export function evidenceUrl(origin: string, m: Pick<Meeting, "id">, id: string) {
  return `${origin}${meetingPath(m.id)}?segment=${encodeURIComponent(id)}`;
}
// Encode punctuation so generated Markdown treats meeting prose as text.
export function literalMarkdown(value: string) {
  return value
    .trim()
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[!-/:-@[-`{-~]/g, (character) => `&#${character.charCodeAt(0)};`);
}
export function markdownEvidence(
  origin: string,
  meeting: Meeting,
  id: string,
  format = literalMarkdown,
) {
  const segment = meeting.segments.find((entry) => entry.id === id)!;
  return `- [${time(segment.start)} · ${format(segment.speaker)}](<${evidenceUrl(origin, meeting, id)}>): “${format(segment.text)}”`;
}
export function adrMarkdown(
  m: Meeting,
  d: Discussion,
  origin: string,
  format = literalMarkdown,
) {
  return `# ${format(d.title)}\n\nStatus: ${d.approved ? "Accepted" : "Proposed"}\nDate: ${m.date.slice(0, 10)}\nMeeting: ${format(m.title)}\n\n## Context\n${format(d.context)}\n\n## Outcome\n${format(d.title)}\n\n## Rationale\n${format(d.rationale)}\n\n## Consequences\n${format(d.consequences)}\n\n## Evidence\n${d.evidence
    .map((id) => markdownEvidence(origin, m, id, format))
    .join("\n")}\n`;
}
export function summaryMarkdown(m: Meeting, origin: string) {
  return `# ${literalMarkdown(m.title)}\n\n${literalMarkdown(m.summary)}\n\n## Discussions\n${
    m.discussions
      .filter((d) => d.approved)
      .map(
        (d) =>
          `- ${literalMarkdown(d.title)} ([evidence](<${evidenceUrl(origin, m, d.evidence[0])}>))`,
      )
      .join("\n") || "No approved discussions."
  }\n\n## Action items\n${
    m.actions
      .filter((a) => a.approved)
      .map(
        (a) =>
          `- ${literalMarkdown(a.title)} — ${literalMarkdown(a.owner || "Unassigned")}${a.due ? ` · due ${a.due}` : ""} ([evidence](<${evidenceUrl(origin, m, a.evidence[0])}>))`,
      )
      .join("\n") || "No approved action items."
  }\n\n[Review meeting](${origin}${meetingPath(m.id)})`;
}
