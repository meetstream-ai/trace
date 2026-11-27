import { importMeetStream } from "@/lib/meetstream/import";
import { linearHistory } from "@/lib/linear-history";
import { extractLinearFollowups } from "@/lib/linear-followups";
import { runtimeConfig } from "@/lib/integration-service";
import { z } from "zod";
import {
  db,
  access,
  audit,
  guard,
  body,
  failure,
  fingerprint,
  HttpError,
} from "@/lib/server";
import { extract, parseTranscript } from "@/lib/extract";
import { meetingSchema, readStoredMeeting } from "@/lib/types";
const providerId = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{1,200}$/);
const input = z.object({
  title: z.string().trim().min(1).max(200),
  project: z.string().trim().max(100).default(""),
  transcript: z.string().min(1).max(500000).optional(),
  transcriptId: providerId.optional(),
  botId: providerId.optional(),
  date: z.string().datetime(),
  useAI: z.boolean().default(false),
});
export async function POST(req: Request) {
  try {
    guard(req);
    const a = await access(req, "edit");
    const owner = a.workspace;
    const parsed = input.safeParse(await body(req));
    if (
      !parsed.success ||
      !(parsed.data.transcript || parsed.data.transcriptId || parsed.data.botId)
    )
      throw new HttpError(
        400,
        "Add a title, meeting date and a transcript under 500 KB.",
      );
    const { transcript, transcriptId, botId } = parsed.data;
    if (botId && await db().prepare("SELECT 1 FROM meetstream_bots WHERE id=? AND workspace<>?")
      .bind(botId, owner).first())
      throw new HttpError(404, "MeetStream bot not found in your workspace.");
    let imported;
    try {
      if (transcriptId || botId) {
        const config = await runtimeConfig(owner);
        imported = await importMeetStream(
          config.MEETSTREAM_API_KEY,
          transcriptId,
          botId,
        );
      } else {
        const segments = parseTranscript(transcript!);
        imported = { segments, original: segments, audioChecked: false };
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (transcriptId || botId)
        throw new HttpError(
          502,
          "MeetStream could not return a usable transcript. Check the meeting and try again.",
        );
      throw new HttpError(400, (e as Error).message);
    }
    const { segments, original, audioChecked } = imported;
    const hash = await fingerprint(original);
    const linkBot = botId && db().prepare(
      `INSERT INTO meetstream_bots (id,workspace,label,created_at,meeting_id)
       SELECT ?,?,?,?,id FROM meetings WHERE owner=? AND fingerprint=?
       ON CONFLICT(id) DO UPDATE SET meeting_id=excluded.meeting_id
       WHERE workspace=excluded.workspace AND meeting_id IS NULL`,
    ).bind(botId, owner, "Existing MeetStream bot", Date.now(), owner, hash);
    const existing = await db()
      .prepare(
        "SELECT data,revision FROM meetings WHERE owner=? AND fingerprint=?",
      )
      .bind(owner, hash)
      .first<{ data: string; revision: number }>();
    if (existing) {
      if (linkBot) await linkBot.run();
      return Response.json({
        meeting: readStoredMeeting(existing.data, existing.revision),
        duplicate: true,
      });
    }
    let output;
    try {
      const config = await runtimeConfig(owner);
      output = await extract(
        segments,
        parsed.data.useAI ? config.ANTHROPIC_API_KEY : undefined,
        config.ANTHROPIC_MODEL,
      );
      const history = await linearHistory(owner, config.LINEAR_TEAM_ID, parsed.data.date);
      output.actions = extractLinearFollowups(output.actions, segments, parsed.data.project, history);
      const followups = output.actions.filter((action) => action.linearFollowup).length;
      if (followups) output.summary = `${output.summary.slice(0, 7900)} Linear follow-up drafts: ${followups}.`;
    } catch {
      throw new HttpError(
        502,
        "Draft extraction failed. Retry with rule-based extraction.",
      );
    }
    const result = meetingSchema.safeParse({
      id: crypto.randomUUID(),
      ...parsed.data,
      ...output,
      segments,
      duration: Math.max(...segments.map((s) => s.end)),
      platform: "Transcript",
      source: transcriptId || botId ? "meetstream" : "import",
      reviewed: false,
      revision: 0,
    });
    if (!result.success)
      throw new HttpError(
        502,
        "Extraction returned invalid evidence or owners. Retry with rule-based extraction.",
      );
    const m = result.data;
    const [insert] = await db().batch([
      db()
        .prepare(
          "INSERT INTO meetings(id,owner,fingerprint,data,revision) VALUES(?,?,?,?,0) ON CONFLICT DO NOTHING",
        )
        .bind(m.id, owner, hash, JSON.stringify(m)),
      audit(a, "meeting.imported", m.id, true),
      ...(linkBot ? [linkBot] : []),
    ]);
    if (!insert.meta.changes) {
      const row = await db()
        .prepare(
          "SELECT data,revision FROM meetings WHERE owner=? AND fingerprint=?",
        )
        .bind(owner, hash)
        .first<{ data: string; revision: number }>();
      return Response.json({
        meeting: readStoredMeeting(row!.data, row!.revision),
        duplicate: true,
      });
    }
    return Response.json(
      { meeting: m, duplicate: false, audioChecked },
      { status: 201 },
    );
  } catch (e) {
    return failure(e);
  }
}
